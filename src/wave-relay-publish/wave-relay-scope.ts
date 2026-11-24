import { WAVES_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { Logger } from '@/logging';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  chainIndexReady,
  waveOnChainSql
} from '@/waves-chain-index/waves-chain-mapping';
import {
  recordsWaveIdFromEnv,
  StayReason,
  wavesScopeSql
} from '@/waves-scope/waves-scope';

/**
 * Which waves' drops go to the 6529 relays: only waves that move to the
 * 6529 chain. A wave that stays on 6529.io keeps its drops on 6529.io,
 * served from MySQL, and they are never published.
 *
 * - Until the chain index has finished a full read (before switch-on, or
 *   while a relaunched chain is read again), the rule decides
 *   (src/waves-scope): a direct message, the records wave, a members-only
 *   wave, or one that uses a hidden or private group stays.
 * - After that the chain index's mapping is the test
 *   (waves-chain-mapping.ts): a wave the chain doesn't hold stays, whatever
 *   the rule says, so a wave the import didn't carry stays. A direct
 *   message and 6529.io's records wave (SIGNED_RECORDS_WAVE_ID) stay
 *   always.
 *
 * The records wave is the named parameter `:<recordsParam>`.
 */
export function stayingWaveSql(
  alias: string,
  chainIndexIsReady: boolean,
  recordsParam = 'recordsWaveId'
): string {
  const scope = wavesScopeSql(alias, recordsParam);
  if (!chainIndexIsReady) return scope.stays;
  return `(${scope.reasons[StayReason.DIRECT_MESSAGE]} or ${scope.reasons[StayReason.RECORDS_WAVE]} or not ${waveOnChainSql(`${alias}.id`)})`;
}

const logger = Logger.get('WAVE_RELAY_SCOPE');

/** The records wave from SIGNED_RECORDS_WAVE_ID (unset: logged once). */
export function recordsWaveId(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  return recordsWaveIdFromEnv(env, (message) => logger.warn(message));
}

export class WaveRelayScope extends LazyDbAccessCompatibleService {
  /**
   * Whether the wave stays on 6529.io, so its drops never go to the relays
   * (stayingWaveSql). Read on the writer. False for a wave with no row.
   */
  async staysOnSite(waveId: string): Promise<boolean> {
    const options = { forcePool: DbPoolName.WRITE };
    const ready = await chainIndexReady(this.db, options);
    const row = await this.db.oneOrNull<{ stays: number | string }>(
      `select ${stayingWaveSql('w', ready)} as stays
         from ${WAVES_TABLE} w where w.id = :waveId`,
      { waveId, recordsWaveId: recordsWaveId() },
      options
    );
    return row !== null && Number(row.stays) === 1;
  }
}

export const waveRelayScope = new WaveRelayScope(dbSupplier);
