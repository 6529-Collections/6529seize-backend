import {
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { sqlExecutor } from '@/sql-executor';
import {
  closeSubscriptionWrites,
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
  JOURNAL_COUNTER_ID
} from '../timeline/journal';
import { sha256Hex } from './opening-file';
import {
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
 * the records wave, from the relays). Nothing in MySQL.
 */
export interface JournalSource {
  walk(chain: 'public'): AsyncIterable<{ readonly entry: RecordLogEntry }>;
}

let boundSource: (() => JournalSource) | null = null;

/**
 * Binds where the CLI's rebuild reads the record log: the records wave
 * reader, once a relay client for the records wave lands. Until then the CLI's
 * rebuild says so and stops.
 */
export function setJournalSource(source: (() => JournalSource) | null): void {
  boundSource = source;
}

export function boundJournalSource(): JournalSource {
  if (!boundSource) {
    throw new Error(
      'No record log source is bound: the rebuild reads the journal from the records wave'
    );
  }
  return boundSource();
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
}

async function journalOf(source: JournalSource): Promise<JournalBody[]> {
  const bodies: JournalBody[] = [];
  for await (const { entry } of source.walk('public')) {
    const body = journalBodyOf(entry);
    if (body) {
      bodies.push(body);
    }
  }
  return bodies;
}

interface PublishedOpening {
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
  const inputs = switched.inputs as {
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

/** Writes stay paused through a rebuild; the marker is renewed this often. */
const MARKER_RENEW_MS = 60 * 1000;

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
): { writes: JournalWriteRecord[]; skipped: number } {
  const byN = new Map<number, JournalBody[]>();
  let skipped = 0;
  for (const body of bodies) {
    if (body.opening !== openingSha256) {
      skipped++;
      continue;
    }
    byN.set(body.n, [...(byN.get(body.n) ?? []), body]);
  }
  const writes = Array.from(byN.entries())
    .sort(([a], [b]) => a - b)
    .map(([n, parts]) => {
      const sorted = [...parts].sort((a, b) => a.part - b.part);
      const expected = sorted[0].parts;
      if (
        sorted.length !== expected ||
        sorted.some((body, i) => body.part !== i || body.parts !== expected)
      ) {
        throw new Error(
          `Journal write n=${n} has ${sorted.length} of its ${expected} parts`
        );
      }
      return { n, bodies: sorted };
    });
  return { writes, skipped };
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
 * 1. pause the unsigned write routes (go-live's marker, renewed by time
 *    while the rebuild runs);
 * 2. read the journal (lanes `subs` and `subs-shadow` of the record log's
 *    public chain);
 * 3. take the opening of the last `opening` entry (go-live writes it with
 *    the switch), fetch its two files and check their sha256; or take the
 *    files given (a rehearsal);
 * 4. load them into tables that are not the truth, and hold them suspended,
 *    so no identity writer writes while the journal is written back;
 * 5. write back every write made against that opening, in `n` order: each
 *    change's captured `before` must equal the rebuilt row, then its
 *    `after` is written;
 * 6. compare each checkpoint's hash once the writes up to its `n` are in;
 * 7. when the live database is there, compare the journal's last `n` with
 *    live's counter: a missing tail leaves the tables suspended, saying
 *    what's missing.
 *
 * Otherwise the rebuilt tables end verified and in shadow, not the truth.
 * With `goLive` they become the truth through go-live's own switch, in the
 * same pause, only if at least one checkpoint matched and the opening came
 * from the journal (so its entry can name the files again). On any failure
 * the routes reopen and the tables are left suspended.
 */
export async function rebuildIdentityTables(params: {
  readonly source: JournalSource;
  readonly fetch?: Fetcher;
  /** A rehearsal: these files instead of the last switched opening. */
  readonly opening?: ParsedOpening;
  readonly goLive?: boolean;
  readonly now?: () => number;
}): Promise<RebuildResult> {
  const now = params.now ?? (() => Date.now());
  await closeSubscriptionWrites(now());
  let renewedAt = now();
  const renewPause = async () => {
    if (now() - renewedAt >= MARKER_RENEW_MS) {
      await closeSubscriptionWrites(now());
      renewedAt = now();
    }
  };
  try {
    const bodies = await journalOf(params.source);
    const published = params.opening
      ? null
      : await lastSwitchedOpening(bodies, params.fetch ?? publicFetcher);
    const opening = params.opening ?? published!.parsed;
    if (params.goLive && !published) {
      throw new Error(
        'Only a rebuild from the journal goes live: rehearsal files name no published opening'
      );
    }
    const { writes, skipped } = writesOf(bodies, opening.openingSha256);
    const lastSeen = bodies.reduce((max, b) => Math.max(max, b.n), 0);
    const live = await liveCounter();
    await loadOpeningFiles(opening, now());
    await setSuspended(now());
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
    const missing =
      live !== null && live > lastSeen
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
        missing
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
      missing: null
    };
  } finally {
    subscriptionsIdentitySwitch.invalidate();
    await openSubscriptionWrites();
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
