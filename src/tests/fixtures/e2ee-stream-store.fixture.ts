import { ethers } from 'ethers';
import { E2eeSealRecipient } from '@/e2ee/relay/e2ee-moderation-seal';
import { e2eeEd25519PublicKey } from '@/e2ee/relay/e2ee-record-event';
import { E2eeRelayIdentity } from '@/e2ee/relay/e2ee-relay-config';
import {
  E2eeRecordBatch,
  E2eeStreamPublisher,
  E2eeTransactionRunner
} from '@/e2ee/relay/e2ee-stream-publisher';
import {
  E2EE_DEL_MAX_IDS,
  E2EE_OUTBOX_PAGE_BYTES,
  E2eeDeletionRow,
  E2eeOutboxInsert,
  E2eeOutboxRow,
  E2eeStreamHead,
  E2eeStreamStore
} from '@/e2ee/relay/e2ee-stream-store';
import { ConnectionWrapper } from '@/sql-executor';
import { loadProviderKeys, ProviderKey } from '@/signed-records/sealed-crypto';

type Conn = ConnectionWrapper<unknown>;

/** The publisher's run, then its background publish (mirror) settled. */
export async function settledRun<T>(
  publisher: E2eeStreamPublisher,
  runner: E2eeTransactionRunner,
  work: (connection: Conn, batch: E2eeRecordBatch | null) => Promise<T>
): Promise<T> {
  try {
    return await publisher.run(runner, work);
  } finally {
    await publisher.settled();
  }
}

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

/** A test moderation service key: its public half and its private keys. */
export function e2eeTestModerationKey(
  seedByte: number,
  id = 'mod-test'
): { readonly recipient: E2eeSealRecipient; readonly keys: ProviderKey[] } {
  const keys = loadProviderKeys(
    JSON.stringify([
      {
        id,
        private_key: `0x${seedByte.toString(16).padStart(2, '0').repeat(32)}`
      }
    ])
  );
  return { recipient: { id, publicKey: keys[0].publicKey }, keys };
}

interface ItemRow {
  wave: string;
  pos: number;
  key: string;
  eventId: string | null;
}

interface DeletionRow {
  id: number;
  wave: string;
  positions: number[];
  event: string | null;
  heldBy: string[];
  attempts: number;
}

interface State {
  heads: Map<string, E2eeStreamHead>;
  updatedAt: Map<string, number>;
  outbox: Map<number, E2eeOutboxRow>;
  items: Map<string, ItemRow>;
  deletions: Map<number, DeletionRow>;
  nextId: number;
}

function cloneState(state: State): State {
  return {
    heads: new Map(state.heads),
    updatedAt: new Map(state.updatedAt),
    items: new Map(
      Array.from(state.items.entries()).map(([key, row]) => [key, { ...row }])
    ),
    deletions: new Map(
      Array.from(state.deletions.entries()).map(([id, row]) => [
        id,
        { ...row, positions: [...row.positions], heldBy: [...row.heldBy] }
      ])
    ),
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
  private state: State = {
    heads: new Map(),
    updatedAt: new Map(),
    outbox: new Map(),
    items: new Map(),
    deletions: new Map(),
    nextId: 1
  };

  get itemRows(): ItemRow[] {
    return Array.from(this.state.items.values());
  }

  get deletionRows(): DeletionRow[] {
    return Array.from(this.state.deletions.values());
  }
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
    now: number,
    connection: Conn
  ): Promise<void> {
    const state = this.on(connection);
    state.heads.set(head.wave, head);
    state.updatedAt.set(head.wave, now);
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
    connection?: Conn,
    afterPos = 0,
    maxBytes = E2EE_OUTBOX_PAGE_BYTES
  ): Promise<E2eeOutboxRow[]> {
    const rows = Array.from(this.on(connection).outbox.values())
      .filter((row) => row.wave === wave && row.pos > afterPos)
      .sort((a, b) => a.pos - b.pos)
      .slice(0, limit);
    const page: E2eeOutboxRow[] = [];
    let total = 0;
    for (const row of rows) {
      total += row.content.length + (row.payload?.length ?? 0);
      if (page.length && total > maxBytes) break;
      page.push({ ...row, heldBy: [...row.heldBy] });
    }
    return page;
  }

  async recentHeads(sinceMs: number, limit: number): Promise<E2eeStreamHead[]> {
    const pending = new Set(
      Array.from(this.state.outbox.values()).map((row) => row.wave)
    );
    return Array.from(this.state.heads.values())
      .filter(
        (head) =>
          head.pos > 0 &&
          !pending.has(head.wave) &&
          (this.state.updatedAt.get(head.wave) ?? 0) >= sinceMs
      )
      .sort(
        (a, b) =>
          (this.state.updatedAt.get(b.wave) ?? 0) -
          (this.state.updatedAt.get(a.wave) ?? 0)
      )
      .slice(0, limit);
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

  async insertItemKeys(
    wave: string,
    pos: number,
    keys: readonly string[],
    _now: number,
    connection: Conn
  ): Promise<void> {
    const state = this.on(connection);
    for (const key of keys) {
      const id = `${wave}#${pos}#${key}`;
      if (!state.items.has(id)) {
        state.items.set(id, { wave, pos, key, eventId: null });
      }
    }
  }

  async saveEventIds(
    rows: readonly { wave: string; pos: number; eventId: string }[],
    connection?: Conn
  ): Promise<void> {
    const state = this.on(connection);
    for (const row of rows) {
      for (const item of Array.from(state.items.values())) {
        if (item.wave === row.wave && item.pos === row.pos && !item.eventId) {
          item.eventId = row.eventId;
        }
      }
    }
  }

  async queueDeletion(
    wave: string,
    keys: readonly string[],
    _now: number,
    keepLatest: boolean,
    connection?: Conn
  ): Promise<number> {
    const state = this.on(connection);
    const matches = (key: string) =>
      keys.some((want) =>
        want.endsWith('*') ? key.startsWith(want.slice(0, -1)) : key === want
      );
    const rows = Array.from(state.items.values()).filter(
      (item) => item.wave === wave && matches(item.key)
    );
    const latest = new Map<string, number>();
    for (const row of rows) {
      latest.set(row.key, Math.max(latest.get(row.key) ?? 0, row.pos));
    }
    const positions = Array.from(
      new Set(
        rows
          .filter((row) => !keepLatest || row.pos !== latest.get(row.key))
          .map((row) => row.pos)
      )
    ).sort((a, b) => a - b);
    for (let at = 0; at < positions.length; at += E2EE_DEL_MAX_IDS) {
      const id = state.nextId++;
      state.deletions.set(id, {
        id,
        wave,
        positions: positions.slice(at, at + E2EE_DEL_MAX_IDS),
        event: null,
        heldBy: [],
        attempts: 0
      });
    }
    return positions.length;
  }

  async listDeletions(limit: number): Promise<E2eeDeletionRow[]> {
    return Array.from(this.state.deletions.values())
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map((row) => ({
        ...row,
        positions: [...row.positions],
        heldBy: [...row.heldBy]
      }));
  }

  async deletionTargets(
    wave: string,
    positions: readonly number[]
  ): Promise<{
    readonly eventIds: ReadonlyMap<number, string | null>;
    readonly pending: boolean;
  }> {
    const eventIds = new Map<number, string | null>();
    for (const item of Array.from(this.state.items.values())) {
      if (item.wave !== wave || !positions.includes(item.pos)) continue;
      eventIds.set(item.pos, eventIds.get(item.pos) ?? item.eventId);
    }
    const pending = Array.from(this.state.outbox.values()).some(
      (row) => row.wave === wave && positions.includes(row.pos)
    );
    return { eventIds, pending };
  }

  async saveDeletionEvent(id: number, event: string): Promise<void> {
    const row = this.state.deletions.get(id);
    if (row && !row.event) row.event = event;
  }

  async markDeletionHeld(id: number, url: string): Promise<void> {
    const row = this.state.deletions.get(id);
    if (row && !row.heldBy.includes(url)) row.heldBy.push(url);
  }

  async markDeletionFailed(id: number): Promise<void> {
    const row = this.state.deletions.get(id);
    if (row) row.attempts++;
  }

  async finishDeletion(row: E2eeDeletionRow): Promise<void> {
    for (const [key, item] of Array.from(this.state.items.entries())) {
      if (item.wave === row.wave && row.positions.includes(item.pos)) {
        this.state.items.delete(key);
      }
    }
    this.state.deletions.delete(row.id);
  }

  async countDeletions(): Promise<number> {
    return this.state.deletions.size;
  }
}
