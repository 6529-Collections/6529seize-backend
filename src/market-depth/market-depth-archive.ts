import { createGzip } from 'node:zlib';
import { Logger } from '@/logging';
import { Time } from '@/time';
import {
  MarketDepthEventInput,
  MarketDepthSnapshotArchive,
  MarketDepthSnapshotMetadata
} from './market-depth.types';

const logger = Logger.get('MARKET_DEPTH_ARCHIVE');

export const MARKET_DEPTH_ARCHIVE_PREFIX = 'market-depth/v1';
const HOUR_MS = Time.hours(1).toMillis();
// Rows carry the time they were written, so an hour is complete once it has
// passed; the margin covers clock skew between writers.
const SETTLE_MS = Time.minutes(10).toMillis();
const EVENT_PAGE_SIZE = 2_000;
const MAX_HOURS_PER_KIND_PER_RUN = 48;

export type MarketDepthArchiveKind = 'snapshots' | 'events';

export interface MarketDepthArchivedEvent extends MarketDepthEventInput {
  chain: string;
  chain_id: string;
  occurred_at: Date;
}

export interface MarketDepthArchiveDb {
  // Earliest row time at or after `from`, or null when there is none.
  getFirstArchivableAtOrAfter(input: {
    kind: MarketDepthArchiveKind;
    contract: string;
    from: Date;
  }): Promise<Date | null>;
  getEventsObservedBetween(input: {
    contract: string;
    from: Date;
    to: Date;
    after: { observed_at: Date; event_id: string } | null;
    limit: number;
  }): Promise<MarketDepthArchivedEvent[]>;
  getSnapshotsCompletedBetween(input: {
    contract: string;
    from: Date;
    to: Date;
  }): Promise<MarketDepthSnapshotMetadata[]>;
  getSnapshotArchive(
    snapshotId: string
  ): Promise<MarketDepthSnapshotArchive | null>;
}

export interface MarketDepthArchiveStore {
  // Everything for this contract before the returned time is archived.
  getArchivedThrough(
    kind: MarketDepthArchiveKind,
    contract: string
  ): Promise<Date | null>;
  setArchivedThrough(
    kind: MarketDepthArchiveKind,
    contract: string,
    archivedThrough: Date
  ): Promise<void>;
  putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<void>;
}

export interface MarketDepthArchivedThrough {
  snapshots: Date | null;
  events: Date | null;
}

interface KindResult {
  hours: number;
  rows: number;
  archived_through: string | null;
  complete: boolean;
}

export interface MarketDepthArchiveResult {
  snapshots: KindResult;
  events: KindResult;
}

class GzipLines {
  private readonly gzip = createGzip();
  private readonly chunks: Buffer[] = [];
  private readonly finished: Promise<void>;
  lines = 0;

  constructor() {
    this.gzip.on('data', (chunk: Buffer) => this.chunks.push(chunk));
    this.finished = new Promise((resolve, reject) => {
      this.gzip.once('end', resolve);
      this.gzip.once('error', reject);
    });
  }

  write(value: unknown): void {
    this.gzip.write(`${JSON.stringify(value)}\n`);
    this.lines++;
  }

  async finish(): Promise<Buffer> {
    this.gzip.end();
    await this.finished;
    return Buffer.concat(this.chunks);
  }
}

function floorHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

function compactTimestamp(at: Date): string {
  return at.toISOString().replace(/[-:.]/g, '');
}

function marketDepthArchiveHourPrefix(
  kind: MarketDepthArchiveKind,
  contract: string,
  hour: Date
): string {
  const iso = hour.toISOString();
  return `${MARKET_DEPTH_ARCHIVE_PREFIX}/${kind}/contract=${contract}/date=${iso.slice(0, 10)}/hour=${iso.slice(11, 13)}`;
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function archiveEventHour(
  input: ArchiveInput,
  from: Date,
  to: Date
): Promise<number> {
  const lines = new GzipLines();
  let after: { observed_at: Date; event_id: string } | null = null;
  for (;;) {
    const page = await input.db.getEventsObservedBetween({
      contract: input.contract,
      from,
      to,
      after,
      limit: EVENT_PAGE_SIZE
    });
    for (const event of page)
      lines.write({ ...event, raw: parseJson(event.raw) });
    const last = page.at(-1);
    if (!last || page.length < EVENT_PAGE_SIZE) break;
    after = { observed_at: last.observed_at, event_id: last.event_id };
  }
  const body = await lines.finish();
  if (lines.lines === 0) return 0;
  await input.store.putObject({
    key: `${marketDepthArchiveHourPrefix('events', input.contract, from)}.jsonl.gz`,
    body,
    contentType: 'application/gzip',
    metadata: {
      rows: String(lines.lines),
      from: from.toISOString(),
      to: to.toISOString()
    }
  });
  return lines.lines;
}

async function archiveSnapshotHour(
  input: ArchiveInput,
  from: Date,
  to: Date
): Promise<number> {
  const snapshots = await input.db.getSnapshotsCompletedBetween({
    contract: input.contract,
    from,
    to
  });
  if (snapshots.length === 0) return 0;
  const prefix = marketDepthArchiveHourPrefix(
    'snapshots',
    input.contract,
    from
  );
  const manifest = new GzipLines();
  for (const snapshot of snapshots) {
    const archive = await input.db.getSnapshotArchive(snapshot.id);
    // Retention never deletes past the watermark, so a missing archive means
    // the snapshot was never stored completely; record that it is absent.
    if (!archive) {
      manifest.write({ ...snapshot, archives: null });
      continue;
    }
    const base = `${prefix}/${compactTimestamp(snapshot.completed_at)}_${snapshot.id}`;
    const metadata = {
      snapshot_id: snapshot.id,
      collection_slug: snapshot.collection_slug,
      completed_at: snapshot.completed_at.toISOString()
    };
    await input.store.putObject({
      key: `${base}.raw.json.gz`,
      body: archive.raw_archive_gzip,
      contentType: 'application/gzip',
      metadata
    });
    await input.store.putObject({
      key: `${base}.normalized.json.gz`,
      body: archive.normalized_archive_gzip,
      contentType: 'application/gzip',
      metadata
    });
    manifest.write({
      ...snapshot,
      archives: {
        raw: `${base}.raw.json.gz`,
        normalized: `${base}.normalized.json.gz`
      }
    });
  }
  await input.store.putObject({
    key: `${prefix}/manifest.jsonl.gz`,
    body: await manifest.finish(),
    contentType: 'application/gzip',
    metadata: { snapshots: String(snapshots.length) }
  });
  return snapshots.length;
}

interface ArchiveInput {
  readonly contract: string;
  readonly db: MarketDepthArchiveDb;
  readonly store: MarketDepthArchiveStore;
  readonly now: () => Date;
}

async function archiveKind(
  input: ArchiveInput,
  kind: MarketDepthArchiveKind,
  deadlineMs: number
): Promise<KindResult> {
  const exportHour = kind === 'events' ? archiveEventHour : archiveSnapshotHour;
  const settledBefore = floorHour(new Date(input.now().getTime() - SETTLE_MS));
  // Start at the hour of the first row not yet archived; empty stretches are
  // skipped in one step rather than walked an hour at a time.
  const nextHourWithRows = async (from: Date) => {
    const first = await input.db.getFirstArchivableAtOrAfter({
      kind,
      contract: input.contract,
      from
    });
    return first && first < settledBefore ? floorHour(first) : settledBefore;
  };
  const stored = await input.store.getArchivedThrough(kind, input.contract);
  let through = await nextHourWithRows(stored ?? new Date(0));
  let hours = 0;
  let rows = 0;
  while (
    through < settledBefore &&
    hours < MAX_HOURS_PER_KIND_PER_RUN &&
    input.now().getTime() < deadlineMs
  ) {
    const to = new Date(through.getTime() + HOUR_MS);
    rows += await exportHour(input, through, to);
    hours++;
    through = await nextHourWithRows(to);
    await input.store.setArchivedThrough(kind, input.contract, through);
  }
  if (hours === 0 && stored?.getTime() !== through.getTime()) {
    // Nothing exported, but the watermark can still move past empty hours.
    await input.store.setArchivedThrough(kind, input.contract, through);
  }
  return {
    hours,
    rows,
    archived_through: through.toISOString(),
    complete: through >= settledBefore
  };
}

/**
 * Uploads completed hours of a contract's snapshots and events to the archive
 * store and advances its per-kind watermark after each hour. Retention reads
 * the watermarks and never deletes rows the archive does not hold yet.
 */
export async function archiveMarketDepthHistory(input: {
  readonly contract: string;
  readonly deadlineMs: number;
  readonly db: MarketDepthArchiveDb;
  readonly store: MarketDepthArchiveStore;
  readonly now?: () => Date;
}): Promise<MarketDepthArchiveResult> {
  const now = input.now ?? (() => new Date());
  const archiveInput: ArchiveInput = {
    contract: input.contract.toLowerCase(),
    db: input.db,
    store: input.store,
    now
  };
  // Snapshots get half of the budget; time they leave unused passes to events.
  const half = Math.max(0, input.deadlineMs - now().getTime()) / 2;
  const snapshots = await archiveKind(
    archiveInput,
    'snapshots',
    Math.min(input.deadlineMs, now().getTime() + half)
  );
  const events = await archiveKind(archiveInput, 'events', input.deadlineMs);
  const result = { snapshots, events };
  logger.info(
    `[CONTRACT ${archiveInput.contract}] Market-depth archive ${JSON.stringify(result)}`
  );
  return result;
}

export async function readArchivedThrough(
  store: MarketDepthArchiveStore,
  contract: string
): Promise<MarketDepthArchivedThrough> {
  const key = contract.toLowerCase();
  return {
    snapshots: await store.getArchivedThrough('snapshots', key),
    events: await store.getArchivedThrough('events', key)
  };
}
