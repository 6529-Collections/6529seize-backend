import { MINT_LOG_CARD_HEADS_TABLE, MINT_LOG_HEAD_TABLE } from '@/constants';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';
import type { MintCardRef, MintLogChain } from './mint-log.types';

export interface MintLogHead {
  readonly seq: number;
  readonly hash: string | null;
}

/** The rows of the chains with one sequence for all their cards. */
const HEAD_IDS: Readonly<Record<string, number>> = {
  mint: 1,
  rememes: 3
};

const CARD_KEY_PREFIX = 'collab:';

/**
 * The head a write locks: `mint` or `rememes` for those chains, and
 * `collab:<drop id>` for a collaboration. A collaboration's writes run
 * inside drop and decision transactions that go on to take other locks, so
 * each artwork keeps its own sequence: a write then waits only for writes to
 * the same artwork, which its collaboration row lock serializes anyway.
 */
export function mintHeadKey(
  chain: MintLogChain,
  card: MintCardRef | null
): string {
  if (chain !== 'collab') return chain;
  if (!card?.key) {
    throw new Error('A collaboration entry needs its drop id as card key');
  }
  return `${CARD_KEY_PREFIX}${card.key}`;
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'ER_DUP_ENTRY';
}

export class MintLogHeadDb extends LazyDbAccessCompatibleService {
  /**
   * Locks the head row until the caller's transaction ends. Every logged
   * write holds its head, so writes and their entries keep one order per
   * head.
   */
  async lock(
    connection: ConnectionWrapper<any>,
    key = 'mint'
  ): Promise<MintLogHead> {
    if (key.startsWith(CARD_KEY_PREFIX)) {
      return this.lockCard(connection, key.slice(CARD_KEY_PREFIX.length));
    }
    const id = this.headId(key);
    await this.db.execute(
      `insert ignore into ${MINT_LOG_HEAD_TABLE} (id, seq, hash, updated_at)
       values (:id, -1, null, :now)`,
      { id, now: Time.currentMillis() },
      { wrappedConnection: connection }
    );
    const row = await this.db.oneOrNull<{ seq: number; hash: string | null }>(
      `select seq, hash from ${MINT_LOG_HEAD_TABLE} where id = :id for update`,
      { id },
      { wrappedConnection: connection }
    );
    if (!row) {
      throw new Error('Mint log head row is missing after insert');
    }
    return { seq: Number(row.seq), hash: row.hash };
  }

  async advance(
    head: MintLogHead,
    connection: ConnectionWrapper<any>,
    key = 'mint'
  ): Promise<void> {
    const now = Time.currentMillis();
    if (key.startsWith(CARD_KEY_PREFIX)) {
      await this.db.execute(
        `update ${MINT_LOG_CARD_HEADS_TABLE}
         set seq = :seq, hash = :hash, updated_at = :now
         where card_key = :card_key`,
        {
          card_key: key.slice(CARD_KEY_PREFIX.length),
          seq: head.seq,
          hash: head.hash,
          now
        },
        { wrappedConnection: connection }
      );
      return;
    }
    await this.db.execute(
      `update ${MINT_LOG_HEAD_TABLE}
       set seq = :seq, hash = :hash, updated_at = :now
       where id = :id`,
      { id: this.headId(key), seq: head.seq, hash: head.hash, now },
      { wrappedConnection: connection }
    );
  }

  private headId(key: string): number {
    const id = HEAD_IDS[key];
    if (id === undefined) throw new Error(`Unknown mint log head ${key}`);
    return id;
  }

  /**
   * A card head is read before it is locked: a locking read of a missing key
   * would lock a gap under REPEATABLE READ and hold up other artworks' first
   * writes until this transaction ends. Only writes to the same artwork,
   * already serialized by its collaboration row, could create the row in
   * between; then the insert fails on the key and the row is locked.
   */
  private async lockCard(
    connection: ConnectionWrapper<any>,
    cardKey: string
  ): Promise<MintLogHead> {
    const locked = () =>
      this.db.oneOrNull<{ seq: number; hash: string | null }>(
        `select seq, hash from ${MINT_LOG_CARD_HEADS_TABLE}
         where card_key = :card_key for update`,
        { card_key: cardKey },
        { wrappedConnection: connection }
      );
    const seen = await this.db.oneOrNull<{ seq: number }>(
      `select seq from ${MINT_LOG_CARD_HEADS_TABLE} where card_key = :card_key`,
      { card_key: cardKey },
      { wrappedConnection: connection }
    );
    if (!seen) {
      try {
        await this.db.execute(
          `insert into ${MINT_LOG_CARD_HEADS_TABLE} (card_key, seq, hash, updated_at)
           values (:card_key, -1, null, :now)`,
          { card_key: cardKey, now: Time.currentMillis() },
          { wrappedConnection: connection }
        );
        return { seq: -1, hash: null };
      } catch (error) {
        if (!isDuplicate(error)) throw error;
      }
    }
    const row = await locked();
    if (!row) throw new Error(`Mint log head ${cardKey} is missing`);
    return { seq: Number(row.seq), hash: row.hash };
  }
}

export const mintLogHeadDb = new MintLogHeadDb(dbSupplier);
