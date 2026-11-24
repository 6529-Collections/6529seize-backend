import { WAVES_SETTLEMENT_SENDS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export type SettlementSendStatus =
  | 'submitting'
  | 'submitted'
  | 'refused'
  | 'error'
  | 'given_up'
  | 'not_yet'
  | 'not_included'
  | 'pending'
  | 'in_block'
  | 'final'
  | 'failed'
  | 'unknown';

/** A row of waves_settlement_sends (see IWavesSettlementSend.ts). */
export interface SettlementSend {
  readonly decision_id: string;
  readonly occurrence: number;
  readonly count_next: number | null;
  readonly nonce_lane: number;
  /** Tries for this step (occurrence and count_next), of any outcome. */
  readonly attempts: number;
  /** Requests for this step that failed in a block, paying their fee. */
  readonly failures: number;
  readonly tx_id: string | null;
  readonly sent_at: number;
  readonly status: SettlementSendStatus;
  readonly last_error: string | null;
}

export interface SettlementSendStore {
  /**
   * The rows of these decisions, and every row with one of `statuses`
   * sent after `sentAfter` (Unix ms).
   */
  load(
    decisionIds: string[],
    statuses: SettlementSendStatus[],
    sentAfter: number
  ): Promise<SettlementSend[]>;
  save(row: SettlementSend): Promise<void>;
}

const COLUMNS = [
  'decision_id',
  'occurrence',
  'count_next',
  'nonce_lane',
  'attempts',
  'failures',
  'tx_id',
  'sent_at',
  'status',
  'last_error'
] as const;

/** Reads and writes go to the writer: the sender reads back its own rows. */
export class WavesSettlementSendsDb
  extends LazyDbAccessCompatibleService
  implements SettlementSendStore
{
  async load(
    decisionIds: string[],
    statuses: SettlementSendStatus[],
    sentAfter: number
  ): Promise<SettlementSend[]> {
    const rows = await this.db.execute<SettlementSend>(
      `select ${COLUMNS.join(', ')} from ${WAVES_SETTLEMENT_SENDS_TABLE}
       where decision_id in (:ids)
          or (status in (:statuses) and sent_at > :sentAfter)`,
      {
        // An empty list is not valid SQL; no decision has this id.
        ids: decisionIds.length ? decisionIds : [''],
        statuses: statuses.length ? statuses : [''],
        sentAfter
      },
      { forcePool: DbPoolName.WRITE }
    );
    return rows.map((row) => ({
      ...row,
      occurrence: Number(row.occurrence),
      count_next: row.count_next === null ? null : Number(row.count_next),
      nonce_lane: Number(row.nonce_lane),
      attempts: Number(row.attempts),
      failures: Number(row.failures),
      sent_at: Number(row.sent_at)
    }));
  }

  async save(row: SettlementSend): Promise<void> {
    await this.db.execute(
      `insert into ${WAVES_SETTLEMENT_SENDS_TABLE}
         (${COLUMNS.join(', ')}, updated_at)
       values (${COLUMNS.map((c) => ':' + c).join(', ')}, :updated_at)
       on duplicate key update
         ${COLUMNS.filter((c) => c !== 'decision_id')
           .map((c) => `${c} = values(${c})`)
           .join(', ')},
         updated_at = values(updated_at)`,
      { ...row, updated_at: Date.now() },
      { forcePool: DbPoolName.WRITE }
    );
  }
}

export const wavesSettlementSendsDb = new WavesSettlementSendsDb(dbSupplier);
