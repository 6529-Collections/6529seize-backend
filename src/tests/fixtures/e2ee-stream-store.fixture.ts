import { ethers } from 'ethers';
import { e2eeEd25519PublicKey } from '@/e2ee/relay/e2ee-record-event';
import { E2eeRelayIdentity } from '@/e2ee/relay/e2ee-relay-config';
import { E2eeTransactionRunner } from '@/e2ee/relay/e2ee-stream-publisher';
import {
  E2eeOutboxInsert,
  E2eeOutboxRow,
  E2eeStreamHead,
  E2eeStreamStore
} from '@/e2ee/relay/e2ee-stream-store';
import { ConnectionWrapper } from '@/sql-executor';

type Conn = ConnectionWrapper<unknown>;

/** A test device key under a well-formed (unsigned) grant proof. */
export function e2eeTestRelayIdentity(
  seedByte: number,
  wallet: string
): E2eeRelayIdentity {
  const seed = Buffer.alloc(32, seedByte);
  const deviceKey = e2eeEd25519PublicKey(seed);
  return {
    seed,
    deviceKey,
    grant: {
      id: ethers.keccak256(ethers.toUtf8Bytes(`test grant ${seedByte}`)),
      message: 'test grant',
      wallet_signature: `0x${'11'.repeat(65)}`,
      chain_id: 1,
      wallet: wallet.toLowerCase(),
      device_key: deviceKey,
      scopes: ['post'],
      domain: '6529 Network P2P',
      expires_at: 4_102_444_800_000,
      revoked_at: null
    }
  };
}

interface State {
  heads: Map<string, E2eeStreamHead>;
  outbox: Map<number, E2eeOutboxRow>;
  nextId: number;
}

function cloneState(state: State): State {
  return {
    heads: new Map(state.heads),
    outbox: new Map(
      Array.from(state.outbox.entries()).map(([id, row]) => [
        id,
        { ...row, heldBy: [...row.heldBy] }
      ])
    ),
    nextId: state.nextId
  };
}

/**
 * The stream store in memory, with transactions: writes made with a
 * connection from `executeNativeQueriesInTransaction` stay staged until the
 * callback returns, and are dropped if it throws.
 */
export class InMemoryE2eeStreamStore
  implements E2eeStreamStore, E2eeTransactionRunner
{
  private state: State = { heads: new Map(), outbox: new Map(), nextId: 1 };
  private readonly staged = new WeakMap<object, State>();

  async executeNativeQueriesInTransaction<T>(
    executable: (connection: Conn) => Promise<T>
  ): Promise<T> {
    const token = {} as Conn;
    const draft = cloneState(this.state);
    this.staged.set(token, draft);
    const result = await executable(token);
    this.state = draft;
    return result;
  }

  private on(connection?: Conn): State {
    if (!connection) return this.state;
    const draft = this.staged.get(connection);
    if (!draft) throw new Error('Unknown connection');
    return draft;
  }

  get outboxRows(): E2eeOutboxRow[] {
    return Array.from(this.state.outbox.values());
  }

  head(wave: string): E2eeStreamHead | null {
    return this.state.heads.get(wave) ?? null;
  }

  async lockHead(
    wave: string,
    _now: number,
    connection: Conn
  ): Promise<E2eeStreamHead> {
    const state = this.on(connection);
    const head = state.heads.get(wave) ?? { wave, pos: 0, hash: null };
    state.heads.set(wave, head);
    return head;
  }

  async saveHead(
    head: E2eeStreamHead,
    _now: number,
    connection: Conn
  ): Promise<void> {
    this.on(connection).heads.set(head.wave, head);
  }

  async insertOutbox(row: E2eeOutboxInsert, connection: Conn): Promise<void> {
    const state = this.on(connection);
    const duplicate = Array.from(state.outbox.values()).some(
      (other) => other.wave === row.wave && other.pos === row.pos
    );
    if (duplicate) throw new Error('Duplicate outbox position');
    const id = state.nextId++;
    state.outbox.set(id, {
      id,
      wave: row.wave,
      pos: row.pos,
      kind: row.kind,
      refs: [...row.refs],
      content: row.content,
      payload: row.payload,
      logMeta: row.logMeta,
      event: null,
      heldBy: [],
      attempts: 0,
      createdAt: row.createdAt
    });
  }

  async listOutbox(
    wave: string,
    limit: number,
    connection?: Conn
  ): Promise<E2eeOutboxRow[]> {
    return Array.from(this.on(connection).outbox.values())
      .filter((row) => row.wave === wave)
      .sort((a, b) => a.pos - b.pos)
      .slice(0, limit)
      .map((row) => ({ ...row, heldBy: [...row.heldBy] }));
  }

  async listPendingWaves(limit: number): Promise<string[]> {
    const first = new Map<string, number>();
    for (const row of Array.from(this.state.outbox.values())) {
      first.set(
        row.wave,
        Math.min(first.get(row.wave) ?? row.createdAt, row.createdAt)
      );
    }
    return Array.from(first.entries())
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([wave]) => wave);
  }

  async saveSignedEvent(
    id: number,
    event: string,
    connection?: Conn
  ): Promise<void> {
    const state = this.on(connection);
    const row = state.outbox.get(id);
    if (row && row.event === null) state.outbox.set(id, { ...row, event });
  }

  async markHeld(
    ids: readonly number[],
    url: string,
    connection?: Conn
  ): Promise<void> {
    const state = this.on(connection);
    for (const id of ids) {
      const row = state.outbox.get(id);
      if (row && !row.heldBy.includes(url)) {
        state.outbox.set(id, { ...row, heldBy: [...row.heldBy, url] });
      }
    }
  }

  async markFailed(ids: readonly number[]): Promise<void> {
    for (const id of ids) {
      const row = this.state.outbox.get(id);
      if (row)
        this.state.outbox.set(id, { ...row, attempts: row.attempts + 1 });
    }
  }

  async deleteOutbox(ids: readonly number[], connection?: Conn): Promise<void> {
    const state = this.on(connection);
    for (const id of ids) state.outbox.delete(id);
  }

  async listHeads(afterWave: string, limit: number): Promise<E2eeStreamHead[]> {
    return Array.from(this.state.heads.values())
      .filter((head) => head.wave > afterWave && head.pos > 0)
      .sort((a, b) => a.wave.localeCompare(b.wave))
      .slice(0, limit);
  }

  async countOutbox(): Promise<{
    rows: number;
    oldestCreatedAt: number | null;
  }> {
    const rows = Array.from(this.state.outbox.values());
    return {
      rows: rows.length,
      oldestCreatedAt: rows.length
        ? Math.min(...rows.map((row) => row.createdAt))
        : null
    };
  }
}
