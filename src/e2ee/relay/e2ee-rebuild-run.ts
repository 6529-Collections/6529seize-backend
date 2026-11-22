import { CrpItem } from '@/e2ee/relay/e2ee-crp';
import {
  E2EE_RECORD_FAMILIES,
  E2eeRebuildProblem,
  E2eeRebuildSource,
  rebuildE2eeStream
} from '@/e2ee/relay/e2ee-rebuild';
import {
  E2eeCoverage,
  E2eeRebuildDb,
  e2eeRebuildDb
} from '@/e2ee/relay/e2ee-rebuild.db';
import { E2eeRelaySettings } from '@/e2ee/relay/e2ee-relay-config';
import { E2eeRelayPool } from '@/e2ee/relay/e2ee-relay-pool';
import {
  E2eeStreamFailure,
  verifyE2eeStreams
} from '@/e2ee/relay/e2ee-stream-verify';
import { Logger } from '@/logging';

const logger = Logger.get('E2EE_REBUILD');
const REPORTED_PROBLEMS = 50;
const ENUMERATE_PAGE = 500;
const BUILD_BATCH = 50;
const DEFAULT_TIME_BUDGET_MS = 10 * 60 * 1000;

/**
 * Where a rebuild reads: every event of a stream (from every relay, once
 * each), payloads by hash, and each relay's events of a family page by
 * page, oldest first, to find the streams.
 */
export type E2eeStreamRebuildSource = E2eeRebuildSource & {
  stream(wave: string): Promise<CrpItem[]>;
  readonly urls: readonly string[];
  page(
    url: string,
    wave: string,
    after: number,
    limit: number
  ): Promise<{ readonly items: CrpItem[]; readonly more: boolean }>;
};

/**
 * Reads from every configured relay and keeps one copy of each event;
 * payloads come from the first relay that has them. Nothing is cached, so
 * a long run never holds more than the stream it is on.
 */
export function relayE2eeRebuildSource(
  pool: E2eeRelayPool
): E2eeStreamRebuildSource {
  const union = async (read: (url: string) => Promise<CrpItem[]>) => {
    const byId = new Map<string, CrpItem>();
    let reached = 0;
    for (const url of pool.urls) {
      try {
        for (const item of await read(url)) {
          if (!byId.has(item.event.id)) byId.set(item.event.id, item);
        }
        reached++;
      } catch (error) {
        logger.warn(`[REBUILD] ${url} unreadable: ${(error as Error).message}`);
      }
    }
    if (!reached) throw new Error('No relay could be read');
    return Array.from(byId.values());
  };
  return {
    urls: pool.urls,
    events: (families) => union((url) => pool.replay(url, families)),
    stream: (wave) => union((url) => pool.stream(url, wave)),
    page: (url, wave, after, limit) => pool.page(url, wave, after, limit),
    async payload(sha256) {
      for (const url of pool.urls) {
        const found = await pool.payload(url, sha256).catch(() => null);
        if (found) return found;
      }
      return null;
    }
  };
}

export interface E2eeRebuildReport {
  readonly mode: 'verify' | 'write';
  /** Streams checked (verify) or written (write) in this slice. */
  readonly streams: number;
  /** verify, first slice only: MySQL entities that have no stream at all. */
  readonly coverage?: E2eeCoverage;
  /** verify: the streams whose rows or head differ. */
  readonly failures?: readonly E2eeStreamFailure[];
  readonly failed?: number;
  /** write: problems in the records of the streams written. */
  readonly problemCount: number;
  readonly problems: readonly E2eeRebuildProblem[];
  /** Pass as `after` to go on; null when the run is complete. */
  readonly next: string | null;
  /** True when this slice found nothing wrong. */
  readonly ok: boolean;
}

interface RunInput {
  readonly mode: 'verify' | 'write';
  readonly now: number;
  readonly settings: E2eeRelaySettings;
  readonly source?: E2eeStreamRebuildSource;
  readonly db?: E2eeRebuildDb;
  /** The previous slice's `next`. */
  readonly after?: string;
  /** verify: streams per slice. */
  readonly limit?: number;
  /** write: when to stop starting streams and hand back a cursor. */
  readonly timeBudgetMs?: number;
  readonly clock?: () => number;
}

/**
 * The rebuild from the relays, one stream at a time, so it runs at
 * production size within a Lambda's memory and time: each call does one
 * slice and returns `next` until the run is complete.
 *
 * - `verify` (the side-by-side check): checks that every MySQL entity has
 *   a stream (first slice), then rebuilds `limit` streams after `after`
 *   alone and compares their rows and heads with MySQL. Writes nothing.
 * - `write`: rebuilds into empty tables (refused otherwise). It first
 *   lists the streams each relay holds (family pages, kept as placeholder
 *   heads in `e2ee_streams`), then rebuilds and writes them one by one,
 *   devices first and the moderators' inbox last. Each stream is written
 *   in one transaction with its head, so a slice cut short is resumed.
 */
export async function runE2eeRebuild(
  input: RunInput
): Promise<E2eeRebuildReport> {
  const db = input.db ?? e2eeRebuildDb;
  const ordererDeviceKey = input.settings.ordererPublicKey;
  if (!ordererDeviceKey) throw new Error('No orderer public key is configured');
  let source = input.source;
  let pool: E2eeRelayPool | null = null;
  if (!source) {
    const reader = input.settings.siteReader;
    if (!reader) throw new Error('No site-reader key is configured');
    pool = new E2eeRelayPool({
      urls: input.settings.urls,
      net: input.settings.net,
      identity: reader
    });
    source = relayE2eeRebuildSource(pool);
  }
  try {
    const options = {
      ordererDeviceKey,
      now: input.now,
      moderationKeys: input.settings.moderationKeys
    };
    if (input.mode === 'verify') {
      const coverage = input.after ? undefined : await db.coverage();
      const report = await verifyE2eeStreams({
        source,
        db,
        ...options,
        after: input.after,
        limit: input.limit ?? 200
      });
      const covered = !coverage || coverage.missing === 0;
      return {
        mode: 'verify',
        streams: report.checked,
        coverage,
        failures: report.failures,
        failed: report.failed,
        problemCount: 0,
        problems: [],
        next: report.next,
        ok: report.ok && covered
      };
    }
    return await writeSlice(input, db, source, options);
  } finally {
    pool?.close();
  }
}

/** Write mode's cursor: listing the streams, or building them. */
type WriteCursor =
  | { readonly phase: 'list'; url: number; family: number; after: number }
  | { readonly phase: 'build' };

function parseCursor(after: string | undefined): WriteCursor | null {
  if (after === undefined) return null;
  if (after === 'build') return { phase: 'build' };
  const match = /^list:(\d+):(\d+):(\d+)$/.exec(after);
  if (!match) throw new Error(`Not a write cursor: ${after}`);
  return {
    phase: 'list',
    url: Number(match[1]),
    family: Number(match[2]),
    after: Number(match[3])
  };
}

async function writeSlice(
  input: RunInput,
  db: E2eeRebuildDb,
  source: E2eeStreamRebuildSource,
  options: Parameters<typeof rebuildE2eeStream>[2]
): Promise<E2eeRebuildReport> {
  const clock = input.clock ?? Date.now;
  const deadline = clock() + (input.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  let cursor = parseCursor(input.after);
  if (cursor === null) {
    const counts = await db.counts();
    const filled = Object.entries(counts).filter(([, count]) => count > 0);
    if (filled.length) {
      throw new Error(
        `Rebuild writes only into empty tables: ${filled
          .map(([table, count]) => `${table} (${count})`)
          .join(', ')}`
      );
    }
    cursor = { phase: 'list', url: 0, family: 0, after: 0 };
  }
  const problems: E2eeRebuildProblem[] = [];
  let problemCount = 0;
  let streams = 0;
  const report = (next: string | null): E2eeRebuildReport => ({
    mode: 'write',
    streams,
    problemCount,
    problems: problems.slice(0, REPORTED_PROBLEMS),
    next,
    ok: problemCount === 0
  });
  while (cursor.phase === 'list') {
    if (clock() >= deadline) {
      return report(`list:${cursor.url}:${cursor.family}:${cursor.after}`);
    }
    const url = source.urls[cursor.url];
    const family = E2EE_RECORD_FAMILIES[cursor.family];
    if (url === undefined) {
      cursor = { phase: 'build' };
      break;
    }
    if (family === undefined) {
      cursor = { phase: 'list', url: cursor.url + 1, family: 0, after: 0 };
      continue;
    }
    let page: Awaited<ReturnType<E2eeStreamRebuildSource['page']>>;
    try {
      page = await source.page(url, family, cursor.after, ENUMERATE_PAGE);
    } catch (error) {
      // A relay that cannot be read lists nothing; the others still do.
      logger.warn(`[REBUILD] ${url} ${family}: ${(error as Error).message}`);
      cursor = { phase: 'list', url: cursor.url + 1, family: 0, after: 0 };
      continue;
    }
    const waves = Array.from(
      new Set(page.items.map((item) => item.event.wave))
    ).filter((wave) => wave.startsWith(`${family}/`));
    await db.addPendingStreams(waves, input.now);
    const last = page.items[page.items.length - 1];
    cursor =
      page.more && last
        ? { ...cursor, after: last.rseq }
        : {
            phase: 'list',
            url: cursor.url,
            family: cursor.family + 1,
            after: 0
          };
  }
  // Devices are written first, so once the inboxes come up every
  // revocation is in MySQL: read them once per slice.
  let revoked: ReadonlySet<string> | null = null;
  for (;;) {
    if (clock() >= deadline) return report('build');
    const pending = await db.pendingStreams(BUILD_BATCH);
    if (!pending.length) break;
    for (const wave of pending) {
      if (clock() >= deadline) return report('build');
      if (wave.startsWith('dv/') && revoked === null) {
        revoked = await db.revokedDevices();
      }
      const stream = await rebuildE2eeStream(source, wave, {
        ...options,
        revokedDevices: revoked ?? new Set<string>()
      });
      await db.writeStream(stream, input.now);
      streams++;
      problemCount += stream.problems.length;
      problems.push(
        ...stream.problems.slice(0, REPORTED_PROBLEMS - problems.length)
      );
    }
  }
  await db.deriveActivity();
  return report(null);
}
