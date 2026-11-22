import {
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import {
  RecordLogReader,
  RecordReplayContext,
  replayRecordLog
} from '@/signed-records/record-log/record-log-reader';
import { compareOrderKeys } from '@/signed-records/record-order';
import type { RecordVerifyResult } from '@/signed-records/record-verify';
import { signedRecordHeadsDb } from '@/signed-records/signed-record-heads.db';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import {
  closeSubscriptionWrites,
  JOURNAL_BEHIND_ID,
  OPENING_STATE_ID,
  openSubscriptionWrites,
  scheduleIdentitySwitch,
  subscriptionsIdentitySwitch
} from '../identity/identity-switch';
import {
  applyJournalBody,
  identityTablesHash,
  journal,
  JournalBody,
  journalBodyOf,
  JOURNAL_COUNTER_ID,
  JOURNAL_LANE
} from '../timeline/journal';
import {
  alertOnJournalFailures,
  EthereumFacts,
  JournalVerifyReport,
  ReplayedSubscriptionEvents,
  SignedEventLookup,
  verifyJournal
} from '../timeline/journal-verify';
import { backendEthereumFacts } from '../timeline/journal-verify-ethereum';
import { canonicalJson, sha256Hex } from './opening-file';
import {
  IDENTITY_DATA_TABLES,
  loadOpeningFiles,
  ParsedOpening,
  parseOpeningFiles
} from './opening-load';

const logger = Logger.get('SUBSCRIPTIONS_REBUILD');

/** Fetches a published file's text by URI (a public GET; no credentials). */
export type Fetcher = (uri: string) => Promise<string>;

export const publicFetcher: Fetcher = async (uri) => {
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`GET ${uri} answered ${response.status}`);
  }
  return response.text();
};

/**
 * What a rebuild reads the journal through: the shared record log's
 * public chain, in log order (the records module's RecordLogReader over
 * the records wave, from the relays). Nothing in MySQL. A source that
 * replays the log (replayRecordLog) gives each entry's `verified` result,
 * null for a service entry; the verifier then checks every choice entry
 * against its signed record. Without it, choice entries go unchecked.
 */
export interface JournalSource {
  walk(chain: 'public'): AsyncIterable<{
    readonly entry: RecordLogEntry;
    readonly verified?: RecordVerifyResult | null;
  }>;
}

let boundSource: (() => JournalSource) | null = null;

/**
 * Binds where the CLI's rebuild reads the record log: the records wave
 * reader over the relays, once a client for them is in the backend. Until
 * then the CLI's rebuild says so and stops.
 */
export function setJournalSource(source: (() => JournalSource) | null): void {
  boundSource = source;
}

/** Whether a records-wave source is bound (the daily check runs only then). */
export function isJournalSourceBound(): boolean {
  return boundSource !== null;
}

/**
 * The daily check of the posted journal: the loaded opening's writes,
 * verified against their money rules, the opening file, Ethereum and their
 * signed records (verifyJournal), alerting on any failure. It reads the
 * records wave, so it runs only once a source is bound, and says so
 * otherwise.
 *
 * First it compares live's counter with the posted journal's highest `n`
 * for the loaded opening. Behind it (a restore from an older backup), live
 * would reuse posted `n`: it sets the behind-posted marker, so every write
 * refuses until go-live loads a new opening, and alerts.
 */
export async function verifyPostedJournal(
  params: { readonly ethereum?: EthereumFacts; readonly fetch?: Fetcher } = {}
): Promise<'not-bound' | 'no-opening' | 'behind' | 'passed' | 'failed'> {
  if (!boundSource) {
    logger.info(
      '[JOURNAL VERIFY] not run: no records-wave source is bound to read the posted journal'
    );
    return 'not-bound';
  }
  const [state] = await sqlExecutor.execute<{ opening_sha256: string }>(
    `SELECT opening_sha256 FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id`,
    { id: OPENING_STATE_ID }
  );
  if (!state) {
    return 'no-opening';
  }
  const { bodies, events } = await readJournal(boundSource());
  const postedMax = bodies
    .filter((b) => b.opening === state.opening_sha256)
    .reduce((max, b) => Math.max(max, b.n), 0);
  const live = (await liveCounter()) ?? 0;
  if (live < postedMax) {
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_CURSORS_TABLE} (id, block, updated_at)
        VALUES (:id, :n, :now)
        ON DUPLICATE KEY UPDATE block = VALUES(block), updated_at = VALUES(updated_at)`,
      { id: JOURNAL_BEHIND_ID, n: postedMax, now: Date.now() }
    );
    logger.errorWithCode(
      'SUBSCRIPTIONS_JOURNAL_BEHIND',
      `[JOURNAL BEHIND POSTED] live's counter is at n=${live}, the posted journal of opening ${state.opening_sha256} at n=${postedMax}: identity writes refuse. Suspend, then go-live for a new opening.`
    );
    return 'behind';
  }
  const named = bodies
    .filter(
      (b) =>
        b.kind === 'opening' && b.inputs.opening_sha256 === state.opening_sha256
    )
    .pop();
  const opening = named
    ? (await fetchNamedOpening(named, params.fetch ?? publicFetcher)).parsed
    : null;
  const report = await verifyJournal(bodies, {
    openingSha256: state.opening_sha256,
    opening: opening?.opening,
    ethereum: params.ethereum ?? backendEthereumFacts(),
    events: events ?? undefined
  });
  return alertOnJournalFailures(report) ? 'passed' : 'failed';
}

export function boundJournalSource(): JournalSource {
  if (!boundSource) {
    throw new Error(
      'No record log source is bound: the rebuild reads the journal from the records wave'
    );
  }
  return boundSource();
}

/**
 * The source to bind over the records wave reader: the public chain
 * replayed with replayRecordLog, so each entry comes with its verification
 * and the verifier checks every choice entry against its signed record.
 * Each entry is handed on as the replay reaches it, and the replay waits
 * until it is taken, so a rebuild renews its pause throughout and holds
 * one entry at a time. A reader that stops partway ends the replay too.
 */
export function replayedJournalSource(
  reader: RecordLogReader,
  context: RecordReplayContext
): JournalSource {
  return {
    async *walk(chain) {
      const state: {
        next: { item: ReplayedEntry; taken: () => void } | null;
        arrived: (() => void) | null;
        finished: boolean;
        stopped: boolean;
        failure: { error: unknown } | null;
      } = {
        next: null,
        arrived: null,
        finished: false,
        stopped: false,
        failure: null
      };
      const wake = () => state.arrived?.();
      const replay = replayRecordLog(
        reader,
        chain,
        context,
        ({ entry }, verified) =>
          state.stopped
            ? Promise.reject(new Error('The journal walk stopped'))
            : new Promise<void>((taken) => {
                state.next = { item: { entry, verified }, taken };
                wake();
              })
      ).then(
        () => {
          state.finished = true;
          wake();
        },
        (error: unknown) => {
          state.failure = { error };
          state.finished = true;
          wake();
        }
      );
      const take = () => {
        const next = state.next;
        state.next = null;
        return next;
      };
      let handedOn: (() => void) | null = null;
      try {
        for (;;) {
          const next = take();
          if (next) {
            handedOn = next.taken;
            yield next.item;
            handedOn = null;
            next.taken();
          } else if (state.finished) {
            break;
          } else {
            await new Promise<void>((resolve) => {
              state.arrived = resolve;
            });
            state.arrived = null;
          }
        }
        await replay;
        if (state.failure) {
          throw state.failure.error;
        }
      } finally {
        if (!state.finished) {
          // The reader stopped partway: let the replay move on to its next
          // entry, which ends it, so it does not wait forever.
          state.stopped = true;
          (handedOn as (() => void) | null)?.();
          take()?.taken();
        }
      }
    }
  };
}

interface ReplayedEntry {
  readonly entry: RecordLogEntry;
  readonly verified: RecordVerifyResult | null;
}

export interface RebuildResult {
  readonly openingSha256: string;
  readonly entries: number;
  readonly checkpoints: number;
  /** Entries of other openings (earlier loads, rehearsals), skipped. */
  readonly skipped: number;
  readonly switched: boolean;
  /** Set when live's counter is ahead of the posted journal. */
  readonly missing: string | null;
  /** The journal verifier's report (it passed, or the rebuild stops). */
  readonly verify: JournalVerifyReport;
}

/**
 * The journal's bodies in log order, and the verified records of lane `subs`
 * from the same walk when the source verifies them.
 */
export async function readJournal(source: JournalSource): Promise<{
  readonly bodies: JournalBody[];
  readonly events: SignedEventLookup | null;
}> {
  const bodies: JournalBody[] = [];
  const events = new ReplayedSubscriptionEvents();
  // Each part once. Entries that were unposted at a restore point are
  // posted again after the restore: a part seen again with the same
  // contents is dropped, and one with other contents (a write that reused
  // a posted n) stops the reading.
  const seen = new Map<string, string>();
  let verifying = false;
  for await (const { entry, verified } of source.walk('public')) {
    verifying = verifying || verified !== undefined;
    const body = journalBodyOf(entry);
    if (body) {
      const key = `${body.opening} ${body.n} ${body.part}`;
      const text = canonicalJson(body);
      const earlier = seen.get(key);
      if (earlier === undefined) {
        seen.set(key, text);
        bodies.push(body);
      } else if (earlier !== text) {
        throw new Error(
          `Journal write n=${body.n} part ${body.part} of opening ${body.opening} was posted twice with different contents`
        );
      }
    } else if (entry.t === 'event' && entry.lane === JOURNAL_LANE && verified) {
      events.add(verified);
    }
  }
  return { bodies, events: verifying ? events : null };
}

export interface PublishedOpening {
  readonly parsed: ParsedOpening;
  readonly openingUri: string;
  readonly historyUri: string;
}

/** The opening of the last switch in the journal, fetched and checked. */
async function lastSwitchedOpening(
  bodies: readonly JournalBody[],
  fetch: Fetcher
): Promise<PublishedOpening> {
  const switched = bodies.filter((b) => b.kind === 'opening').pop();
  if (!switched) {
    throw new Error('The journal names no opening that went live');
  }
  return fetchNamedOpening(switched, fetch);
}

/** The two files an `opening` entry names, fetched and checked against their sha256. */
export async function fetchNamedOpening(
  entry: JournalBody,
  fetch: Fetcher
): Promise<PublishedOpening> {
  const inputs = entry.inputs as {
    opening_uri: string;
    opening_sha256: string;
    history_uri: string;
    history_sha256: string;
  };
  const openingBytes = await fetch(inputs.opening_uri);
  const historyBytes = await fetch(inputs.history_uri);
  if (sha256Hex(openingBytes) !== inputs.opening_sha256) {
    throw new Error(
      `${inputs.opening_uri} does not hash to ${inputs.opening_sha256}`
    );
  }
  if (sha256Hex(historyBytes) !== inputs.history_sha256) {
    throw new Error(
      `${inputs.history_uri} does not hash to ${inputs.history_sha256}`
    );
  }
  return {
    parsed: parseOpeningFiles(openingBytes, historyBytes),
    openingUri: inputs.opening_uri,
    historyUri: inputs.history_uri
  };
}

/**
 * Writes stay paused through a rebuild: the marker lapses after
 * SWITCH_CUT_WINDOW_MS, so it is renewed this often while the rebuild
 * reads, verifies and writes back.
 */
const MARKER_RENEW_MS = 60 * 1000;

/** The port, renewing the pause before each call (each is a network read). */
function renewingEthereum(
  ethereum: EthereumFacts,
  renew: () => Promise<void>
): EthereumFacts {
  return {
    topUp: async (hash) => {
      await renew();
      return ethereum.topUp(hash);
    },
    mintedTo: async (hash, contract, tokenId, to) => {
      await renew();
      return ethereum.mintedTo(hash, contract, tokenId, to);
    }
  };
}

/** One journaled write: its parts, in order, all present. */
interface JournalWriteRecord {
  readonly n: number;
  readonly bodies: JournalBody[];
}

/**
 * The target opening's writes, in `n` order. Every part of a write must be
 * there; a write with a missing part is a gap, and the rebuild stops.
 */
function writesOf(
  bodies: readonly JournalBody[],
  openingSha256: string
): {
  writes: JournalWriteRecord[];
  skipped: number;
  /** The last write, posted only in part (a segment ended inside it). */
  partial: { n: number; have: number; parts: number } | null;
} {
  const byN = new Map<number, JournalBody[]>();
  let skipped = 0;
  for (const body of bodies) {
    if (body.opening !== openingSha256) {
      skipped++;
      continue;
    }
    byN.set(body.n, [...(byN.get(body.n) ?? []), body]);
  }
  const ordered = Array.from(byN.entries()).sort(([a], [b]) => a - b);
  const writes: JournalWriteRecord[] = [];
  let partial: { n: number; have: number; parts: number } | null = null;
  for (let index = 0; index < ordered.length; index++) {
    const [n, parts] = ordered[index];
    const sorted = [...parts].sort((a, b) => a.part - b.part);
    const expected = sorted[0].parts;
    const complete =
      sorted.length === expected &&
      sorted.every((body, i) => body.part === i && body.parts === expected);
    if (complete) {
      writes.push({ n, bodies: sorted });
      continue;
    }
    // The closer can end a segment between a write's parts: the last write
    // is then a tail still being posted. Anywhere else it is a gap.
    if (index === ordered.length - 1 && sorted.every((b, i) => b.part === i)) {
      partial = { n, have: sorted.length, parts: expected };
      continue;
    }
    throw new Error(
      `Journal write n=${n} has ${sorted.length} of its ${expected} parts`
    );
  }
  return { writes, skipped, partial };
}

/**
 * Why the identity tables are not lost, or null when they and their state
 * row are empty.
 */
async function identityTablesInUse(): Promise<string | null> {
  const [state] = await sqlExecutor.execute<{ id: string }>(
    `SELECT id FROM ${SUBSCRIPTIONS_ID_STATE_TABLE} WHERE id = :id`,
    { id: OPENING_STATE_ID }
  );
  if (state) {
    return 'their state row is still there';
  }
  for (const table of IDENTITY_DATA_TABLES) {
    const [row] = await sqlExecutor.execute<{ one: number }>(
      `SELECT 1 AS one FROM ${table} LIMIT 1`
    );
    if (row) {
      return `${table} still holds rows`;
    }
  }
  return null;
}

async function liveCounter(): Promise<number | null> {
  const [row] = await sqlExecutor.execute<{ block: number | string }>(
    `SELECT block FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id`,
    { id: JOURNAL_COUNTER_ID }
  );
  return row ? Number(row.block) : null;
}

/**
 * Rebuilds the identity tables from the opening file and the journal alone:
 *
 * 1. pause the unsigned write routes with go-live's marker, renewed
 *    every minute while the rebuild reads the journal, checks it against
 *    Ethereum and writes it back, and after the files are fetched and
 *    loaded;
 * 2. read the journal (lanes `subs` and `subs-shadow` of the record log's
 *    public chain);
 * 3. take the opening of the last `opening` entry (go-live writes it with
 *    the switch), fetch its two files and check their sha256; or take the
 *    files given (a rehearsal);
 * 4. verify that opening's journal (journal-verify.ts): the money rules
 *    from the opening's balances on, the order and parts of its writes,
 *    and, through the ports given, Ethereum and the signed records; a
 *    failure alerts and stops the rebuild before anything is loaded;
 * 5. load them into tables that are not the truth, and hold them suspended,
 *    so no identity writer writes while the journal is written back;
 * 6. write back every write made against that opening, in `n` order: each
 *    change's captured `before` must equal the rebuilt row, then its
 *    `after` is written;
 * 7. compare each checkpoint's hash once the writes up to its `n` are in;
 * 8. when the live database is there, compare the journal's last `n` with
 *    live's counter: a missing tail leaves the tables suspended, saying
 *    what's missing.
 *
 * Otherwise the rebuilt tables end verified and in shadow, not the truth.
 * With `goLive` they become the truth through go-live's own switch, in the
 * same pause, only if at least one checkpoint matched, the opening came
 * from the journal (so its entry can name the files again) and the journal
 * was checked against Ethereum. On any failure the routes reopen and the
 * tables are left suspended.
 *
 * `goLive` is for a lost database only: it refuses unless the identity
 * tables and their state row are empty when the rebuild starts. While the
 * identity tables are suspended, or before the switch, writes land in the
 * legacy tables with no journal, so a rebuild from the journal would miss
 * them; after a suspend, only go-live, which cuts from the legacy tables,
 * switches.
 */
export async function rebuildIdentityTables(params: {
  readonly source: JournalSource;
  readonly fetch?: Fetcher;
  /** A rehearsal: these files instead of the last switched opening. */
  readonly opening?: ParsedOpening;
  readonly goLive?: boolean;
  /** Checks the journal's top-ups and mints against Ethereum (network calls). */
  readonly ethereum?: EthereumFacts;
  readonly now?: () => number;
}): Promise<RebuildResult> {
  const now = params.now ?? (() => Date.now());
  if (params.goLive && !params.ethereum) {
    throw new Error(
      'A rebuild goes live only with its journal checked against Ethereum'
    );
  }
  if (params.goLive) {
    const held = await identityTablesInUse();
    if (held) {
      throw new Error(
        `A rebuild goes live only over lost identity tables, and ${held}. ` +
          'Writes made while they were suspended, or before the switch, are in the legacy tables and not in the journal; switch with go-live, which cuts from the legacy tables.'
      );
    }
  }
  await closeSubscriptionWrites(now());
  let renewedAt = now();
  const renewPause = async () => {
    if (now() - renewedAt >= MARKER_RENEW_MS) {
      await closeSubscriptionWrites(now());
      renewedAt = now();
    }
  };
  const source = params.source;
  try {
    const { bodies, events } = await readJournal({
      async *walk(chain) {
        for await (const item of source.walk(chain)) {
          await renewPause();
          yield item;
        }
      }
    });
    const published = params.opening
      ? null
      : await lastSwitchedOpening(bodies, params.fetch ?? publicFetcher);
    const opening = params.opening ?? published!.parsed;
    if (params.goLive && !published) {
      throw new Error(
        'Only a rebuild from the journal goes live: rehearsal files name no published opening'
      );
    }
    await renewPause();
    // A last write posted only in part is the tail, reported below, not a
    // broken write: the verifier checks the complete writes.
    const { writes, skipped, partial } = writesOf(
      bodies,
      opening.openingSha256
    );
    const complete = partial
      ? bodies.filter(
          (b) => !(b.opening === opening.openingSha256 && b.n === partial.n)
        )
      : bodies;
    // Nothing is loaded from a journal that breaks the money rules, or
    // that could not be checked.
    const verify = await verifyJournal(complete, {
      openingSha256: opening.openingSha256,
      opening: opening.opening,
      ethereum:
        params.ethereum && renewingEthereum(params.ethereum, renewPause),
      events: events ?? undefined
    }).catch((error: unknown) => {
      logger.errorWithCode(
        'SUBSCRIPTIONS_JOURNAL_VERIFY_FAILED',
        `[JOURNAL VERIFY FAILED] opening ${opening.openingSha256} could not be checked: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    });
    if (!alertOnJournalFailures(verify)) {
      throw new Error(
        `The journal fails verification (${verify.failures.length}): ${verify.failures.slice(0, 3).join('; ')}`
      );
    }
    const lastSeen = bodies.reduce((max, b) => Math.max(max, b.n), 0);
    const live = await liveCounter();
    await loadOpeningFiles(opening, now());
    await setSuspended(now());
    await renewPause();
    const checkpoints = writes
      .flatMap((w) => w.bodies)
      .filter((b) => b.checkpoint !== null)
      .map((b) => b.checkpoint!)
      .sort((a, b) => a.through_n - b.through_n);
    let compared = 0;
    const compareThrough = async (throughBelow: number) => {
      while (
        compared < checkpoints.length &&
        checkpoints[compared].through_n < throughBelow
      ) {
        const checkpoint = checkpoints[compared];
        const rebuilt = await identityTablesHash({});
        if (rebuilt !== checkpoint.state_sha256) {
          throw new Error(
            `The rebuilt tables differ from the checkpoint through journal n=${checkpoint.through_n}`
          );
        }
        compared++;
      }
    };
    for (const write of writes) {
      await compareThrough(write.n);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const options = { wrappedConnection: connection };
          for (const body of write.bodies) {
            await applyJournalBody(body, options);
          }
          await restoreRecordHead(write.bodies[0], connection);
        }
      );
      await renewPause();
    }
    await compareThrough(Number.POSITIVE_INFINITY);
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_CURSORS_TABLE} (id, block, updated_at)
        VALUES (:id, :n, :now)
        ON DUPLICATE KEY UPDATE block = GREATEST(block, VALUES(block))`,
      { id: JOURNAL_COUNTER_ID, n: lastSeen, now: now() }
    );
    const missing = partial
      ? `The posted journal ends inside write n=${partial.n} (${partial.have} of its ${partial.parts} parts). Wait for the next segment, then rebuild again.`
      : live !== null && live > lastSeen
        ? `The posted journal ends at n=${lastSeen}; live's counter is at n=${live}. Close and post the open segment, then rebuild again.`
        : null;
    if (missing) {
      logger.errorWithCode('SUBSCRIPTIONS_JOURNAL_TAIL_MISSING', missing);
      return {
        openingSha256: opening.openingSha256,
        entries: writes.length,
        checkpoints: compared,
        skipped,
        switched: false,
        missing,
        verify
      };
    }
    // Verified and back in shadow: the identity writers go on from here.
    await sqlExecutor.execute(
      `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
          SET verified_at = :nowMs, suspended_at = NULL
        WHERE id = :id`,
      { nowMs: now(), id: OPENING_STATE_ID }
    );
    let switched = false;
    if (params.goLive) {
      if (compared === 0) {
        throw new Error(
          'No checkpoint was compared; the rebuilt tables stay in shadow'
        );
      }
      switched = await switchRebuilt(opening, published!, now());
    }
    return {
      openingSha256: opening.openingSha256,
      entries: writes.length,
      checkpoints: compared,
      skipped,
      switched,
      missing: null,
      verify
    };
  } finally {
    subscriptionsIdentitySwitch.invalidate();
    await openSubscriptionWrites();
  }
}

/**
 * A choice's signed record is the newest for its (owner, type, key) when it
 * is applied; the records module keeps that order key in
 * signed_record_heads, and refuses an older record live. A rebuild puts the
 * head back from the choice entry, so a lost heads table never lets an old
 * record be replayed within the live window.
 */
async function restoreRecordHead(
  body: JournalBody,
  connection: ConnectionWrapper<unknown>
): Promise<void> {
  if (body.kind !== 'choice') {
    return;
  }
  const inputs = body.inputs as {
    event_id: string;
    owner: string;
    family?: 'ps' | 'pv';
    type: string;
    key: string;
    anchor: number;
    claimed_time: number;
  };
  const head = {
    owner: inputs.owner,
    // The family the record was signed in; subscription choices are `ps`.
    family: inputs.family ?? ('ps' as const),
    type: inputs.type,
    key: inputs.key
  };
  const order = {
    anchor: Number(inputs.anchor),
    claimedTime: Number(inputs.claimed_time),
    eventId: inputs.event_id
  };
  const ctx = { connection };
  const current = await signedRecordHeadsDb.lock(head, ctx);
  if (!current || compareOrderKeys(order, current) > 0) {
    await signedRecordHeadsDb.put(head, order, ctx);
  }
}

async function setSuspended(nowMs: number): Promise<void> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE} SET suspended_at = :nowMs WHERE id = :id`,
    { nowMs, id: OPENING_STATE_ID }
  );
}

/**
 * The rebuilt tables are current as of now (writes are paused, and every
 * journaled write is in them), so the cut is now and the switch follows
 * it, with the journal's opening entry naming the same files again.
 */
async function switchRebuilt(
  opening: ParsedOpening,
  published: PublishedOpening,
  nowMs: number
): Promise<boolean> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE}
        SET cut_at = :nowMs, opening_uri = :openingUri, history_uri = :historyUri
      WHERE id = :id`,
    {
      nowMs,
      openingUri: published.openingUri,
      historyUri: published.historyUri,
      id: OPENING_STATE_ID
    }
  );
  return scheduleIdentitySwitch(nowMs, opening.openingSha256, (options) =>
    journal(
      {
        kind: 'opening',
        inputs: {
          opening_uri: published.openingUri,
          opening_sha256: opening.openingSha256,
          history_uri: published.historyUri,
          history_sha256: opening.historySha256,
          cut_at: opening.opening.cut.at,
          rebuilt: true
        }
      },
      options
    ).then(() => undefined)
  );
}
