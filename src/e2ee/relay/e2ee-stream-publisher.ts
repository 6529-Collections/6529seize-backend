import {
  e2eeSha256,
  E2eeRowOp,
  encodeE2eeRecordContent
} from '@/e2ee/relay/e2ee-record-container';
import {
  e2eeFamilyWave,
  E2eeRecordFamily,
  E2eeRecordKind,
  E2eeSignedRecordEvent,
  signE2eeRecord
} from '@/e2ee/relay/e2ee-record-event';
import {
  E2eeRelayMode,
  e2eeRelaySettings,
  E2eeRelaySettings
} from '@/e2ee/relay/e2ee-relay-config';
import { E2eeRelayPayload, E2eeRelayPool } from '@/e2ee/relay/e2ee-relay-pool';
import {
  E2eeOutboxRow,
  E2eeStreamStore,
  e2eeStreamStore
} from '@/e2ee/relay/e2ee-stream-store';
import { Logger } from '@/logging';
import { ConnectionWrapper } from '@/sql-executor';

const logger = Logger.get('E2EE_RELAY_PUBLISHER');

type Conn = ConnectionWrapper<unknown>;

/** Bodies up to this much base64url carry the content inline. */
const INLINE_CONTENT_CHARS = 48 * 1024;
/** RECORD bodies are at most 16 KiB. */
const RECORD_BODY_MAX_CHARS = 16 * 1024 - 64;
const OUTBOX_PAGE = 200;
const PRIMARY_PUBLISH_TIMEOUT_MS = 4_000;
const MIRROR_PUBLISH_TIMEOUT_MS = 2_000;
const CATCH_UP_PROBABILITY = 0.05;
const CATCH_UP_WAVES = 5;

/** A device's delivery window in a group, for the relay. */
export interface E2eeDeliveryWindow {
  readonly d: string;
  readonly from: number;
  readonly to: number | null;
}

/** One change of the delivery service, as one record in one stream. */
export interface E2eeRecordAppend {
  readonly family: E2eeRecordFamily;
  readonly owner: string;
  readonly kind:
    | typeof E2eeRecordKind.RECORD
    | typeof E2eeRecordKind.SEALED
    | typeof E2eeRecordKind.LOG;
  /** RECORD: `[type]` or `[type, key]`; SEALED: `[label]`; LOG: `[item]`. */
  readonly refs: readonly string[];
  /** What the record is, e.g. `item`, `genesis`, `welcome`, `device`. */
  readonly type: string;
  readonly ops: readonly E2eeRowOp[];
  /** LOG records only: the group's epoch after the change, and windows. */
  readonly log?: {
    readonly epoch: number | null;
    readonly windows: readonly E2eeDeliveryWindow[];
  };
}

/** Where the orderer takes its anchor: a recent finalized chain height. */
export interface E2eeAnchorSource {
  anchor(): Promise<number>;
}

export interface E2eeTransactionRunner {
  executeNativeQueriesInTransaction<T>(
    executable: (connection: Conn) => Promise<T>
  ): Promise<T>;
}

export class E2eeRelayQuorumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eeRelayQuorumError';
    Object.setPrototypeOf(this, E2eeRelayQuorumError.prototype);
  }
}

/** A record content's hash: what the next record names as `prev`. */
export const e2eeContentHash = e2eeSha256;

export interface E2eePublisherDeps {
  readonly settings: () => E2eeRelaySettings;
  readonly store: E2eeStreamStore;
  readonly pool: () => E2eeRelayPool;
  readonly anchors: E2eeAnchorSource;
  readonly now: () => number;
  /** Uniform [0, 1); for the after-commit catch-up odds. */
  readonly random?: () => number;
}

/** The records appended in one transaction. */
export class E2eeRecordBatch {
  private readonly waves = new Set<string>();

  constructor(private readonly publisher: E2eeStreamPublisher) {}

  get touched(): readonly string[] {
    return Array.from(this.waves);
  }

  /** Appends one record to its stream, in the caller's transaction. */
  async append(connection: Conn, input: E2eeRecordAppend): Promise<void> {
    const wave = await this.publisher.appendRecord(connection, input);
    this.waves.add(wave);
  }
}

/**
 * Turns the delivery service's writes into hash-chained, orderer-signed
 * records and gets them onto the relays.
 *
 * Inside a write's transaction, `append` locks the stream's head, gives the
 * record the next position and the previous record's content hash, and
 * queues it in the outbox. Signing waits for the first publish, so the
 * anchor is the relays' current height; the signed event is then kept, and
 * every relay gets the same event id.
 *
 * - `mirror`: after the commit the batch's streams are published with a
 *   short time limit; later writes and the `e2ee-relay-publish` operator
 *   scope retry what is left.
 * - `primary`: before the commit, every stream the batch touched must reach
 *   the quorum, or the write fails (503) and rolls back.
 */
export class E2eeStreamPublisher {
  private lastSeq = 0;

  constructor(private readonly deps: E2eePublisherDeps) {}

  mode(): E2eeRelayMode {
    return this.deps.settings().mode;
  }

  /** A batch for one transaction, or null when records are off. */
  batch(): E2eeRecordBatch | null {
    return this.mode() === 'off' ? null : new E2eeRecordBatch(this);
  }

  /**
   * Runs `work` in a transaction with a batch (null when records are off),
   * and publishes what the batch appended as the mode says.
   */
  async run<T>(
    runner: E2eeTransactionRunner,
    work: (connection: Conn, batch: E2eeRecordBatch | null) => Promise<T>
  ): Promise<T> {
    const batch = this.batch();
    const result = await runner.executeNativeQueriesInTransaction(
      async (connection) => {
        const value = await work(connection, batch);
        if (batch) await this.beforeCommit(batch, connection);
        return value;
      }
    );
    if (batch) await this.afterCommit(batch);
    return result;
  }

  /** `primary`: the batch's streams reach the quorum, or this throws. */
  async beforeCommit(batch: E2eeRecordBatch, connection: Conn): Promise<void> {
    if (this.mode() !== 'primary' || !batch.touched.length) return;
    const settings = this.deps.settings();
    let outcome:
      | Awaited<ReturnType<E2eeStreamPublisher['publishWave']>>[]
      | 'timeout';
    try {
      outcome = await withTimeout(
        Promise.all(
          batch.touched.map((wave) => this.publishWave(wave, connection))
        ),
        PRIMARY_PUBLISH_TIMEOUT_MS
      );
    } catch (error) {
      throw new E2eeRelayQuorumError(
        `Records could not reach the relays: ${(error as Error).message}`
      );
    }
    if (outcome === 'timeout') {
      throw new E2eeRelayQuorumError(
        `Relays did not confirm within ${PRIMARY_PUBLISH_TIMEOUT_MS} ms`
      );
    }
    const short = outcome.find((result) => result.minHolders < settings.quorum);
    if (short) {
      throw new E2eeRelayQuorumError(
        `Stream ${short.wave} reached ${short.minHolders} of ${settings.quorum} relays`
      );
    }
  }

  /**
   * After the commit: publish the batch's streams, best effort. About one
   * write in twenty also retries a few streams other writes left behind
   * (relay outages), as retention pruning piggybacks on writes.
   */
  async afterCommit(batch: E2eeRecordBatch): Promise<void> {
    if (!batch.touched.length) return;
    const catchUp = (this.deps.random ?? Math.random)() < CATCH_UP_PROBABILITY;
    try {
      const outcome = await withTimeout(
        Promise.all(batch.touched.map((wave) => this.publishWave(wave))).then(
          () => (catchUp ? this.publishPending(CATCH_UP_WAVES) : undefined)
        ),
        MIRROR_PUBLISH_TIMEOUT_MS
      );
      if (outcome === 'timeout') {
        logger.warn('[AFTER COMMIT] relays slow; later writes retry');
      }
    } catch (error) {
      logger.warn(
        `[AFTER COMMIT] publish failed; later writes retry: ${(error as Error).message}`
      );
    }
  }

  async appendRecord(
    connection: Conn,
    input: E2eeRecordAppend
  ): Promise<string> {
    const wave = e2eeFamilyWave(input.family, input.owner);
    const now = this.deps.now();
    const head = await this.deps.store.lockHead(wave, now, connection);
    const pos = head.pos + 1;
    const { content, external } = encodeE2eeRecordContent({
      type: input.type,
      pos,
      prev: head.hash,
      ops: input.ops
    });
    if (external.length > 1) {
      throw new Error('A record carries at most one external payload');
    }
    if (external.length && input.kind !== E2eeRecordKind.LOG) {
      throw new Error('Only LOG records carry external payloads');
    }
    await this.deps.store.insertOutbox(
      {
        wave,
        pos,
        kind: input.kind,
        refs: input.refs,
        content,
        payload: external[0] ?? null,
        logMeta: input.log
          ? {
              epoch: input.log.epoch,
              item: input.type,
              windows: input.log.windows
            }
          : null,
        createdAt: now
      },
      connection
    );
    await this.deps.store.saveHead(
      { wave, pos, hash: e2eeContentHash(content) },
      now,
      connection
    );
    return wave;
  }

  private nextSeq(now: number): number {
    this.lastSeq = Math.max(this.lastSeq + 1, now * 1000);
    return this.lastSeq;
  }

  /**
   * The record's body and the payloads it names.
   * - LOG (`cv`): `{seq, epoch, item, windows, ds, data}`. `ds` is the
   *   content, inline or a payload reference; `data` references the item's
   *   ciphertext (the content's external bytes), which the relays drop at
   *   the end of their retention while the body stays.
   * - SEALED: `{c, v}` inline, or `{h, n, v}` with the content as a payload.
   * - RECORD (`dr`): `{c, v}`, always inline (at most 16 KiB).
   */
  private recordBody(row: E2eeOutboxRow): {
    readonly body: Record<string, unknown>;
    readonly payloads: E2eeRelayPayload[];
  } {
    const encoded = row.content.toString('base64url');
    const inline = encoded.length <= INLINE_CONTENT_CHARS;
    const contentRef = {
      h: e2eeContentHash(row.content),
      n: row.content.length
    };
    const payloads: E2eeRelayPayload[] = inline
      ? []
      : [{ sha256: contentRef.h, bytes: row.content }];
    if (row.kind === E2eeRecordKind.LOG) {
      const meta = row.logMeta ?? {};
      const data = row.payload
        ? { h: e2eeContentHash(row.payload), n: row.payload.length }
        : null;
      if (row.payload && data) {
        payloads.push({ sha256: data.h, bytes: row.payload });
      }
      return {
        body: {
          seq: row.pos,
          epoch: meta.epoch ?? null,
          item: meta.item ?? null,
          windows: meta.windows ?? [],
          ds: inline ? encoded : contentRef,
          data
        },
        payloads
      };
    }
    if (row.kind === E2eeRecordKind.RECORD) {
      if (!inline || encoded.length > RECORD_BODY_MAX_CHARS) {
        throw new Error(`RECORD ${row.wave}#${row.pos} is over 16 KiB`);
      }
      return { body: { c: encoded, v: 1 }, payloads: [] };
    }
    return {
      body: inline ? { c: encoded, v: 1 } : { ...contentRef, v: 1 },
      payloads
    };
  }

  private async sign(row: E2eeOutboxRow): Promise<E2eeSignedRecordEvent> {
    const orderer = this.deps.settings().orderer;
    if (!orderer) throw new Error('No orderer key is configured');
    const now = this.deps.now();
    const { body } = this.recordBody(row);
    return signE2eeRecord({
      draft: {
        kind: row.kind as E2eeRecordKind,
        wave: row.wave,
        refs: row.refs,
        body
      },
      seed: orderer.seed,
      grant: orderer.grant,
      seq: this.nextSeq(now),
      anchor: await this.deps.anchors.anchor(),
      claimedTime: now
    });
  }

  /** Signs the rows that have no event yet, keeping whichever was first. */
  private async signRows(
    wave: string,
    rows: E2eeOutboxRow[],
    connection?: Conn
  ): Promise<E2eeOutboxRow[]> {
    const unsigned = rows.filter((row) => row.event === null);
    if (!unsigned.length) return rows;
    for (const row of unsigned) {
      const event = await this.sign(row);
      await this.deps.store.saveSignedEvent(
        row.id,
        JSON.stringify(event),
        connection
      );
    }
    return this.deps.store.listOutbox(wave, OUTBOX_PAGE, connection);
  }

  /**
   * Publishes a stream's outbox rows to every relay that lacks them, in
   * position order, and drops the rows every relay holds. Returns the
   * fewest relays holding any of the rows.
   */
  async publishWave(
    wave: string,
    connection?: Conn
  ): Promise<{ readonly wave: string; readonly minHolders: number }> {
    const settings = this.deps.settings();
    let rows = await this.deps.store.listOutbox(wave, OUTBOX_PAGE, connection);
    if (!rows.length) return { wave, minHolders: settings.urls.length };
    rows = await this.signRows(wave, rows, connection);
    const holders = new Map(rows.map((row) => [row.id, new Set(row.heldBy)]));
    const pool = this.deps.pool();
    await Promise.all(
      settings.urls.map(async (url) => {
        const missing = rows.filter((row) => !row.heldBy.includes(url));
        if (!missing.length) return;
        const result = await pool.publishSequence(
          url,
          missing.map((row) => ({
            event: JSON.parse(row.event!) as E2eeSignedRecordEvent,
            payloads: this.recordBody(row).payloads
          }))
        );
        const held = missing.slice(0, result.held).map((row) => row.id);
        for (const id of held) holders.get(id)?.add(url);
        await this.deps.store.markHeld(held, url, connection);
        if (result.error && !connection) {
          await this.deps.store.markFailed(
            missing.slice(result.held).map((row) => row.id),
            `${url}: ${result.error.message}`
          );
        }
      })
    );
    const everywhere = rows
      .filter((row) =>
        settings.urls.every((url) => holders.get(row.id)?.has(url))
      )
      .map((row) => row.id);
    await this.deps.store.deleteOutbox(everywhere, connection);
    const minHolders = Math.min(
      ...rows.map((row) => holders.get(row.id)?.size ?? 0)
    );
    return { wave, minHolders };
  }

  /** Publishes streams with records still pending, oldest first. */
  async publishPending(maxWaves: number): Promise<{
    readonly waves: number;
    readonly complete: number;
  }> {
    const waves = await this.deps.store.listPendingWaves(maxWaves);
    let complete = 0;
    for (const wave of waves) {
      try {
        const result = await this.publishWave(wave);
        if (result.minHolders >= this.deps.settings().urls.length) complete++;
      } catch (error) {
        logger.warn(`[LOOP] ${wave}: ${(error as Error).message}`);
      }
    }
    return { waves: waves.length, complete };
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number
): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The relays' own height, from their WELCOME frames. */
export function relayHeadAnchorSource(
  pool: () => E2eeRelayPool
): E2eeAnchorSource {
  return {
    async anchor() {
      const relays = pool();
      if (relays.head === null && relays.urls[0]) {
        await relays.connection(relays.urls[0]).catch(() => undefined);
      }
      if (relays.head === null || relays.head <= 0) {
        throw new Error('No relay reported a finalized height for anchors');
      }
      return relays.head;
    }
  };
}

let defaultPool: E2eeRelayPool | null = null;

function defaultRelayPool(): E2eeRelayPool {
  if (!defaultPool) {
    const settings = e2eeRelaySettings();
    if (!settings.orderer) throw new Error('No orderer key is configured');
    defaultPool = new E2eeRelayPool({
      urls: settings.urls,
      net: settings.net,
      identity: settings.orderer
    });
  }
  return defaultPool;
}

export const e2eeStreamPublisher = new E2eeStreamPublisher({
  settings: e2eeRelaySettings,
  store: e2eeStreamStore,
  pool: defaultRelayPool,
  anchors: relayHeadAnchorSource(defaultRelayPool),
  now: () => Date.now()
});
