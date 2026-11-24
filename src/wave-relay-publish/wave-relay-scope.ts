import { WAVES_TABLE } from '@/constants';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { Logger } from '@/logging';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import {
  chainIndexReady,
  expectedChainNetwork,
  waveOnChainSql
} from '@/waves-chain-index/waves-chain-mapping';
import { recordsWaveIdFromEnv, wavesScopeSql } from '@/waves-scope/waves-scope';

/**
 * Which waves' drops go to the 6529 relays: only waves that move to the
 * 6529 chain. A wave that stays on 6529.io keeps its drops on 6529.io,
 * served from MySQL, and they are never published.
 *
 * - Before the switch-on (WAVES_SWITCH_ON_AT, FEATURE_WAVES_ON_CHAIN) the
 *   rule decides (src/waves-scope): a direct message, the records wave, a
 *   members-only wave, a wave that uses a hidden or private group, and a
 *   subwave of any of these stay. Mode `rule`.
 * - After the switch-on, once the chain index has finished a full read (on
 *   the chain's network, WAVES_SETTLEMENT_NETWORK_ID, when set), the chain
 *   decides: a wave stays unless the chain holds it, and a direct message
 *   and the records wave stay always. Mode `chain`.
 * - After the switch-on and before that full read: mode `hold`. The
 *   publisher reads nothing (its cursor waits, so no event is passed over),
 *   and the API keeps the rule, so a moving wave still needs signatures.
 *
 * The records wave is the named parameter `:<recordsParam>`.
 */
export type RelayScopeMode = 'rule' | 'hold' | 'chain';

const logger = Logger.get('WAVE_RELAY_SCOPE');

export const WAVES_SWITCH_ON_AT_ENV = 'WAVES_SWITCH_ON_AT';
export const WAVES_ON_CHAIN_FLAG_ENV = 'FEATURE_WAVES_ON_CHAIN';

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;
const END_OF_DAY = /T24:00(?::00(?:\.0{1,3})?)?(?:Z|[+-]00:00)$/;
const EARLIEST_MS = Date.UTC(2020, 0, 1);
const LATEST_MS = Date.UTC(2100, 0, 1);
const isTime = (millis: number) =>
  Number.isFinite(millis) && millis >= EARLIEST_MS && millis < LATEST_MS;

/**
 * The switch-on time from WAVES_SWITCH_ON_AT, read as the waves freeze reads
 * WAVES_FREEZE_AT (ISO 8601 UTC, or Unix milliseconds, from 2020 to 2099;
 * 24:00 is the next day's 00:00): `undefined` when unset, `null` when it is
 * not such a time.
 */
export function parseSwitchOnAt(
  raw: string | undefined
): number | null | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d{1,16}$/.test(value)) {
    const millis = Number(value);
    return isTime(millis) ? millis : null;
  }
  if (!ISO_UTC.test(value)) return null;
  const millis = Date.parse(value);
  const day = value.slice(0, 10);
  const [year, month, date] = day.split('-').map(Number);
  if (
    !isTime(millis) ||
    new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== day
  ) {
    return null;
  }
  if (END_OF_DAY.test(value)) return millis;
  return new Date(millis).toISOString().slice(0, 10) === day ? millis : null;
}

let warnedAboutSwitchOnAt = false;

/**
 * Whether waves have switched on on the 6529 chain: FEATURE_WAVES_ON_CHAIN
 * is `true`, or the time in WAVES_SWITCH_ON_AT has come. A
 * WAVES_SWITCH_ON_AT that is not a time does not switch on, and is logged
 * once. The waves freeze reads the same settings the same way.
 */
export function wavesSwitchedOn(
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowMillis: number = Date.now()
): boolean {
  if (env[WAVES_ON_CHAIN_FLAG_ENV] === 'true') return true;
  const raw = env[WAVES_SWITCH_ON_AT_ENV];
  const at = parseSwitchOnAt(raw);
  if (at === undefined) return false;
  if (at === null) {
    if (!warnedAboutSwitchOnAt) {
      warnedAboutSwitchOnAt = true;
      logger.error(
        `[${WAVES_SWITCH_ON_AT_ENV} IS NOT A UTC TIME] [VALUE ${raw}] [NOT SWITCHED ON]`
      );
    }
    return false;
  }
  return nowMillis >= at;
}

/** The records wave from SIGNED_RECORDS_WAVE_ID (unset: none, logged once). */
export function recordsWaveId(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  return recordsWaveIdFromEnv(env, (message) => logger.warn(message));
}

/** Where the move stands for the relays (RelayScopeMode). */
export async function relayScopeMode(
  db: Pick<SqlExecutor, 'execute'>,
  options: DbQueryOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowMillis: number = Date.now()
): Promise<RelayScopeMode> {
  if (!wavesSwitchedOn(env, nowMillis)) return 'rule';
  return (await chainIndexReady(db, options, expectedChainNetwork(env)))
    ? 'chain'
    : 'hold';
}

/**
 * The SQL condition "the waves row `alias` stays on 6529.io": the rule
 * (mode `rule`), or the chain's mapping (mode `chain`).
 */
export function stayingWaveSql(
  alias: string,
  mode: Exclude<RelayScopeMode, 'hold'>,
  recordsParam = 'recordsWaveId'
): string {
  return mode === 'chain'
    ? wavesScopeSql(alias, recordsParam, {
        switchedOn: true,
        heldSql: waveOnChainSql
      }).stays
    : wavesScopeSql(alias, recordsParam).stays;
}

export class WaveRelayScope extends LazyDbAccessCompatibleService {
  /**
   * Whether the wave stays on 6529.io, so its drops never go to the relays
   * (stayingWaveSql). Before the chain index's first full read after the
   * switch-on, the rule decides (`hold`): a moving wave still needs
   * signatures. Read on the writer. False for a wave with no row.
   */
  async staysOnSite(waveId: string): Promise<boolean> {
    const options = { forcePool: DbPoolName.WRITE };
    const mode = await relayScopeMode(this.db, options);
    const row = await this.db.oneOrNull<{ stays: number | string }>(
      `select ${stayingWaveSql('w', mode === 'chain' ? 'chain' : 'rule')} as stays
         from ${WAVES_TABLE} w where w.id = :waveId`,
      { waveId, recordsWaveId: recordsWaveId() },
      options
    );
    return row !== null && Number(row.stays) === 1;
  }
}

export const waveRelayScope = new WaveRelayScope(dbSupplier);
