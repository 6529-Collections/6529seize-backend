import { MINT_LOG_HEAD_TABLE } from '@/constants';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';

export interface MintLogHead {
  readonly seq: number;
  readonly hash: string | null;
}

const HEAD_ID = 1;

export class MintLogHeadDb extends LazyDbAccessCompatibleService {
  /**
   * Locks the head row until the caller's transaction ends. Every logged
   * mint write holds it, so writes and their entries keep one order.
   */
  async lock(connection: ConnectionWrapper<any>): Promise<MintLogHead> {
    await this.db.execute(
      `insert ignore into ${MINT_LOG_HEAD_TABLE} (id, seq, hash, updated_at)
       values (:id, -1, null, :now)`,
      { id: HEAD_ID, now: Time.currentMillis() },
      { wrappedConnection: connection }
    );
    const row = await this.db.oneOrNull<{ seq: number; hash: string | null }>(
      `select seq, hash from ${MINT_LOG_HEAD_TABLE} where id = :id for update`,
      { id: HEAD_ID },
      { wrappedConnection: connection }
    );
    if (!row) {
      throw new Error('Mint log head row is missing after insert');
    }
    return { seq: Number(row.seq), hash: row.hash };
  }

  async advance(
    head: MintLogHead,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `update ${MINT_LOG_HEAD_TABLE}
       set seq = :seq, hash = :hash, updated_at = :now
       where id = :id`,
      {
        id: HEAD_ID,
        seq: head.seq,
        hash: head.hash,
        now: Time.currentMillis()
      },
      { wrappedConnection: connection }
    );
  }
}

export const mintLogHeadDb = new MintLogHeadDb(dbSupplier);
