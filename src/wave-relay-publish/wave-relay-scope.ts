import { WAVES_TABLE } from '@/constants';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { Logger } from '@/logging';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import {
  ChainIndexProgress,
  chainIndexProgress,
  expectedChainNetwork,
  waveOnChainSql
} from '@/waves-chain-index/waves-chain-mapping';
import { SCOPE_SQL_PARAMS, wavesScopeSql } from '@/waves-scope/waves-scope';

/**
 * Which waves' drops go to the 6529 relays: only waves that move to the
 * 6529 chain. A wave that stays on 6529.io keeps its drops on 6529.io,
 * served from MySQL, and they are never published.
 *
 * - Before the switch-on (WAVES_SWITCH_ON_AT, FEATURE_WAVES_ON_CHAIN) the
 *   rule decides (src/waves-scope): a direct message, the records wave, a
 *   members-only wave, a wave that uses a hidden or private group, one made
 *   after the freeze, and a subwave of any of these stay. Mode `rule`.
 * - After the switch-on, once the chain index has finished a full read (on
 *   the chain's network, WAVES_SETTLEMENT_NETWORK_ID, when set), the chain
 *   decides: a wave stays unless the chain holds it, and a direct message
 *   and the records wave stay always. Mode `chain`.
 * - After the switch-on and before that full read: mode `hold`. The
 *   publisher reads nothing (its cursor waits, so no event is passed over)
 *   and warns each run with the reason. The API reads the rule, with a wave
 *   made on the chain counted as moved, so a moving wave still needs
 *   signatures.
 */
export type RelayScopeMode = 'rule' | 'hold' | 'chain';

const logger = Logger.get('WAVE_RELAY_SCOPE');

export const WAVES_SWITCH_ON_AT_ENV = 'WAVES_SWITCH_ON_AT';
export const WAVES_ON_CHAIN_FLAG_ENV = 'FEATURE_WAVES_ON_CHAIN';
export const WAVES_FREEZE_AT_ENV = 'WAVES_FREEZE_AT';
export const RECORDS_WAVE_ENV = 'SIGNED_RECORDS_WAVE_ID';
/** The records wave setting that says, on purpose, there is none. */
export const NO_RECORDS_WAVE = 'none';

const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]00:00)$/;
const END_OF_DAY = /T24:00(?::00(?:\.0{1,3})?)?(?:Z|[+-]00:00)$/;
const EARLIEST_MS = Date.UTC(2020, 0, 1);
const LATEST_MS = Date.UTC(2100, 0, 1);
const isTime = (millis: number) =>
  Number.isFinite(millis) && millis >= EARLIEST_MS && millis < LATEST_MS;

/**
 * A time as the waves freeze reads WAVES_FREEZE_AT (ISO 8601 UTC, or Unix
 * milliseconds, from 2020 to 2099; 24:00 is the next day's 00:00; a day
 * that doesn't exist is no time): `undefined` when unset, `null` when it is
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

/**
 * SIGNED_RECORDS_WAVE_ID: the records wave's id, `none` (there is none, on
 * purpose), or unset.
 */
export type RecordsWaveSetting =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unset' };

export function recordsWaveSetting(
  env: Readonly<Record<string, string | undefined>> = process.env
): RecordsWaveSetting {
  const value = env[RECORDS_WAVE_ENV]?.trim();
  if (!value) return { kind: 'unset' };
  if (value === NO_RECORDS_WAVE) return { kind: 'none' };
  return { kind: 'id', id: value };
}

let toldAboutRecordsWave = false;

/**
 * The records wave's id for the SQL form, or null for none and for unset
 * (each logged once: none as information, unset as a warning).
 */
export function recordsWaveId(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  const setting = recordsWaveSetting(env);
  if (setting.kind === 'id') return setting.id;
  if (!toldAboutRecordsWave) {
    toldAboutRecordsWave = true;
    if (setting.kind === 'none') {
      logger.info(`[${RECORDS_WAVE_ENV} IS none] [NO RECORDS WAVE]`);
    } else {
      logger.warn(
        `[${RECORDS_WAVE_ENV} IS NOT SET] [NO WAVE STAYS AS THE RECORDS WAVE] [SET IT, OR TO none WHEN THERE IS NONE]`
      );
    }
  }
  return null;
}

/**
 * The SQL form's named parameters (SCOPE_SQL_PARAMS): the records wave, and
 * the freeze time from WAVES_FREEZE_AT as milliseconds and as a Date (null
 * when unset or not a time).
 */
export function scopeSqlParamValues(
  records: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, unknown> {
  const freezeAtMs = parseSwitchOnAt(env[WAVES_FREEZE_AT_ENV]) ?? null;
  return {
    [SCOPE_SQL_PARAMS.records]: records,
    [SCOPE_SQL_PARAMS.freezeAtMs]: freezeAtMs,
    [SCOPE_SQL_PARAMS.freezeAt]:
      freezeAtMs === null ? null : new Date(freezeAtMs)
  };
}

/** Where the move stands for the relays (RelayScopeMode), and why. */
export async function relayScopeMode(
  db: Pick<SqlExecutor, 'execute'>,
  options: DbQueryOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowMillis: number = Date.now()
): Promise<{ mode: RelayScopeMode; progress: ChainIndexProgress | null }> {
  if (!wavesSwitchedOn(env, nowMillis)) return { mode: 'rule', progress: null };
  const progress = await chainIndexProgress(
    db,
    options,
    expectedChainNetwork(env)
  );
  return { mode: progress.ready ? 'chain' : 'hold', progress };
}

const NOT_READY_TEXT: Record<string, string> = {
  no_tables: "THE CHAIN INDEX'S TABLES ARE NOT THERE",
  no_state: 'THE CHAIN INDEX HAS NOT RUN (IS FEATURE_WAVES_CHAIN_INDEX ON?)',
  no_full_read: 'THE CHAIN INDEX HAS NOT FINISHED A FULL READ',
  other_network:
    'THE CHAIN INDEX IS ON ANOTHER NETWORK THAN WAVES_SETTLEMENT_NETWORK_ID'
};

/** One publishing run's scope: publish in a mode, or don't, and why. */
export type RelayRunScope =
  | {
      readonly publish: true;
      readonly mode: Exclude<RelayScopeMode, 'hold'>;
      readonly recordsWaveId: string | null;
    }
  | {
      readonly publish: false;
      readonly level: 'warn' | 'error';
      readonly reason: string;
    };

/**
 * Whether this run publishes, and how. Before the switch-on the rule needs
 * the records wave named (its id, or `none`): unset, the records wave would
 * read as a moving wave and its signed drops would go to the relays, so
 * nothing is published and that is an error each run. After the switch-on
 * the chain's mapping keeps the records wave off without the setting; until
 * the index's full read the run holds, with a warning each run.
 */
export async function relayRunScope(
  db: Pick<SqlExecutor, 'execute'>,
  options: DbQueryOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowMillis: number = Date.now()
): Promise<RelayRunScope> {
  const { mode, progress } = await relayScopeMode(db, options, env, nowMillis);
  if (mode === 'hold') {
    const why =
      NOT_READY_TEXT[progress?.notReady ?? ''] ??
      'THE CHAIN INDEX IS NOT READY';
    const error = progress?.lastError
      ? ` [INDEX ERROR ${progress.lastError.slice(0, 300)}]`
      : '';
    return {
      publish: false,
      level: 'warn',
      reason: `[WAVE RELAY PUBLISHING HOLDS AFTER THE SWITCH-ON] [${why}]${error} [NOTHING IS PASSED OVER]`
    };
  }
  if (mode === 'rule' && recordsWaveSetting(env).kind === 'unset') {
    return {
      publish: false,
      level: 'error',
      reason: `[WAVE RELAY PUBLISHING REFUSED] [${RECORDS_WAVE_ENV} IS NOT SET] [THE RECORDS WAVE WOULD GO TO THE RELAYS] [SET IT TO ITS ID, OR TO none WHEN THERE IS NONE]`
    };
  }
  return { publish: true, mode, recordsWaveId: recordsWaveId(env) };
}

/**
 * The SQL condition "the waves row `alias` stays on 6529.io": the rule
 * (`rule`), the rule with a chain-made wave moved (`not_ready`: after the
 * switch-on, before the index's full read), or the chain's mapping
 * (`chain`). Its parameters are scopeSqlParamValues'.
 */
export function stayingWaveSql(
  alias: string,
  state: 'rule' | 'not_ready' | 'chain'
): string {
  if (state === 'rule') return wavesScopeSql(alias).stays;
  return wavesScopeSql(alias, {
    switchedOn: true,
    heldSql: state === 'chain' ? waveOnChainSql : null
  }).stays;
}

export class WaveRelayScope extends LazyDbAccessCompatibleService {
  /**
   * Whether the wave stays on 6529.io, so its drops never go to the relays
   * (stayingWaveSql). Read on the writer. False for a wave with no row.
   */
  async staysOnSite(waveId: string): Promise<boolean> {
    const options = { forcePool: DbPoolName.WRITE };
    const { mode } = await relayScopeMode(this.db, options);
    const state =
      mode === 'rule' ? 'rule' : mode === 'chain' ? 'chain' : 'not_ready';
    const row = await this.db.oneOrNull<{ stays: number | string }>(
      `select ${stayingWaveSql('w', state)} as stays
         from ${WAVES_TABLE} w where w.id = :waveId`,
      { waveId, ...scopeSqlParamValues(recordsWaveId()) },
      options
    );
    return row !== null && Number(row.stays) === 1;
  }
}

export const waveRelayScope = new WaveRelayScope(dbSupplier);
