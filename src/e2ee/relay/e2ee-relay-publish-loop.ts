import { CrpItem } from '@/e2ee/relay/e2ee-crp';
import { e2eeSha256 } from '@/e2ee/relay/e2ee-record-container';
import {
  E2eeRecordKind,
  E2eeSignedRecordEvent
} from '@/e2ee/relay/e2ee-record-event';
import {
  E2eeRelayMode,
  e2eeRelaySettings,
  E2eeRelaySettings
} from '@/e2ee/relay/e2ee-relay-config';
import {
  E2eeRelayPayload,
  E2eeRelayPool,
  isE2eeChainRecord
} from '@/e2ee/relay/e2ee-relay-pool';
import {
  e2eeDefaultRelayPool,
  E2eeStreamPublisher,
  e2eeStreamPublisher
} from '@/e2ee/relay/e2ee-stream-publisher';
import {
  E2eeRelayFailures,
  E2eeStreamHead,
  E2eeStreamStore,
  e2eeStreamStore
} from '@/e2ee/relay/e2ee-stream-store';
import { Logger } from '@/logging';

const logger = Logger.get('E2EE_RELAY_PUBLISH_LOOP');

/** Streams the loop publishes per run, the longest waiting first. */
const PENDING_WAVES = 500;
/** Heads that moved this recently are checked on every relay. */
const HEAD_CHECK_WINDOW_MS = 15 * 60 * 1000;
const HEAD_CHECK_STREAMS = 200;

export interface E2eeRelayLoopDeps {
  readonly settings: () => E2eeRelaySettings;
  readonly publisher: Pick<
    E2eeStreamPublisher,
    'mode' | 'publishPending' | 'publishDeletions'
  >;
  readonly store: Pick<
    E2eeStreamStore,
    'recentHeads' | 'countOutbox' | 'countDeletions' | 'worstFailures'
  >;
  readonly pool: () => E2eeRelayPool;
  readonly now: () => number;
  /** Where each run's lag goes as metrics (CloudWatch in the Lambda). */
  readonly metrics?: (report: E2eeRelayLoopReport) => void;
}

export interface E2eeRelayLoopReport {
  readonly mode: E2eeRelayMode;
  readonly published: { readonly waves: number; readonly complete: number };
  /** The mirror lag: records MySQL committed that a relay still lacks. */
  readonly outbox: {
    readonly rows: number;
    readonly oldestAgeMs: number | null;
  };
  /** DELs sent this run, and those still waiting (a relay refused them). */
  readonly deletions: { readonly done: number; readonly waiting: number };
  /**
   * The waiting record and DEL that failed most often, with the last
   * error a relay gave (`last_error`); null when nothing failed.
   */
  readonly failures: E2eeRelayFailures;
  readonly heads: {
    readonly checked: number;
    /** `wave@relay` of each relay found behind a stream's head. */
    readonly behind: readonly string[];
    readonly repaired: number;
    readonly unrepaired: readonly string[];
  };
}

type RefValue = string | { readonly h?: unknown } | null | undefined;

function contentRefOf(event: E2eeSignedRecordEvent): RefValue {
  if (!event.body) return null;
  const body = JSON.parse(event.body) as Record<string, unknown>;
  if (event.kind === E2eeRecordKind.LOG) return body.ds as RefValue;
  if (typeof body.c === 'string') return body.c;
  return body as RefValue;
}

/**
 * The content hash a relay's event carries: what the stream head in MySQL
 * names. Inline content is hashed; a payload reference is the hash.
 */
export function e2eeEventContentHash(
  event: E2eeSignedRecordEvent
): string | null {
  const ref = contentRefOf(event);
  if (typeof ref === 'string') {
    return e2eeSha256(Buffer.from(ref, 'base64url'));
  }
  return typeof ref?.h === 'string' ? ref.h : null;
}

/** Every payload an event names (`h` at any depth of its body). */
function payloadRefs(event: E2eeSignedRecordEvent): string[] {
  if (!event.body) return [];
  const refs: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record.h === 'string') refs.push(record.h);
    Object.values(record).forEach(visit);
  };
  visit(JSON.parse(event.body));
  return refs;
}

/**
 * Copies a stream's records that relay `to` lacks from relay `from`, in
 * order, with their payloads: how a relay that missed records (an outage
 * after the outbox let them go, a relay restored from an old disk) catches
 * up. Payloads `from` no longer holds (a message past retention) leave
 * their event out; the relay would refuse it. DELs are not copied: the
 * publisher sends each one to every relay itself, and they sit outside
 * the chain the copy follows.
 */
export async function copyE2eeStream(
  pool: E2eeRelayPool,
  input: { readonly from: string; readonly to: string; readonly wave: string }
): Promise<number> {
  const items = (await pool.stream(input.from, input.wave)).filter(
    isE2eeChainRecord
  );
  const newest = await pool.newest(input.to, input.wave);
  const start = newest
    ? items.findIndex((item) => item.event.id === newest.event.id) + 1
    : 0;
  const records: {
    event: E2eeSignedRecordEvent;
    grant: CrpItem['grant'];
    payloads: E2eeRelayPayload[];
  }[] = [];
  for (const item of items.slice(start)) {
    const payloads: E2eeRelayPayload[] = [];
    let complete = true;
    for (const sha256 of payloadRefs(item.event)) {
      const bytes = await pool.payload(input.from, sha256).catch(() => null);
      if (!bytes) {
        complete = false;
        break;
      }
      payloads.push({ sha256, bytes });
    }
    if (complete) {
      records.push({ event: item.event, grant: item.grant, payloads });
    }
  }
  const result = await pool.publishSequence(input.to, records);
  return result.held;
}

async function checkHead(
  deps: E2eeRelayLoopDeps,
  head: E2eeStreamHead
): Promise<{ behind: string[]; repaired: number; unrepaired: string[] }> {
  const pool = deps.pool();
  const holders: string[] = [];
  const behind: string[] = [];
  for (const url of pool.urls) {
    const newest = await pool.newest(url, head.wave).catch(() => undefined);
    if (newest === undefined) continue;
    if (newest && e2eeEventContentHash(newest.event) === head.hash) {
      holders.push(url);
    } else {
      behind.push(url);
    }
  }
  let repaired = 0;
  const unrepaired: string[] = [];
  for (const url of behind) {
    const from = holders[0];
    if (from) {
      await copyE2eeStream(pool, { from, to: url, wave: head.wave }).catch(
        (error: Error) =>
          logger.warn(`[COPY ${head.wave}] ${from} to ${url}: ${error.message}`)
      );
      const newest = await pool.newest(url, head.wave).catch(() => null);
      if (newest && e2eeEventContentHash(newest.event) === head.hash) {
        repaired++;
        continue;
      }
    }
    unrepaired.push(`${head.wave}@${url}`);
  }
  return {
    behind: behind.map((url) => `${head.wave}@${url}`),
    repaired,
    unrepaired
  };
}

/**
 * The publisher loop (every minute while records are on): publishes what
 * the outbox still holds, reports the mirror lag, and checks that every
 * relay holds the head of each stream that moved lately, copying missing
 * records from a relay that has them.
 */
export async function runE2eeRelayPublishLoop(
  deps: E2eeRelayLoopDeps
): Promise<E2eeRelayLoopReport> {
  const mode = deps.publisher.mode();
  if (mode === 'off') {
    return {
      mode,
      published: { waves: 0, complete: 0 },
      outbox: { rows: 0, oldestAgeMs: null },
      deletions: { done: 0, waiting: 0 },
      failures: { outbox: null, deletion: null },
      heads: { checked: 0, behind: [], repaired: 0, unrepaired: [] }
    };
  }
  const published = await deps.publisher.publishPending(PENDING_WAVES);
  const deleted = await deps.publisher.publishDeletions(PENDING_WAVES);
  const outbox = await deps.store.countOutbox();
  const waitingDeletions = await deps.store.countDeletions();
  const failures =
    outbox.rows || waitingDeletions
      ? await deps.store.worstFailures()
      : { outbox: null, deletion: null };
  const heads = await deps.store.recentHeads(
    deps.now() - HEAD_CHECK_WINDOW_MS,
    HEAD_CHECK_STREAMS
  );
  const behind: string[] = [];
  const unrepaired: string[] = [];
  let repaired = 0;
  for (const head of heads) {
    const result = await checkHead(deps, head);
    behind.push(...result.behind);
    unrepaired.push(...result.unrepaired);
    repaired += result.repaired;
  }
  const report: E2eeRelayLoopReport = {
    mode,
    published,
    outbox: {
      rows: outbox.rows,
      oldestAgeMs:
        outbox.oldestCreatedAt === null
          ? null
          : deps.now() - outbox.oldestCreatedAt
    },
    deletions: { done: deleted.done, waiting: waitingDeletions },
    failures,
    heads: { checked: heads.length, behind, repaired, unrepaired }
  };
  if (unrepaired.length || outbox.rows || waitingDeletions) {
    logger.warn(`[LAG] ${JSON.stringify(report)}`);
  }
  try {
    deps.metrics?.(report);
  } catch (error) {
    logger.warn(`[METRICS] ${(error as Error).message}`);
  }
  return report;
}

/** The lag as metric values: what the dashboard and the alarm read. */
export function e2eeRelayLagMetrics(
  report: E2eeRelayLoopReport
): Record<string, number> {
  return {
    OutboxRows: report.outbox.rows,
    OutboxOldestAgeSeconds: Math.floor((report.outbox.oldestAgeMs ?? 0) / 1000),
    OutboxMostAttempts: report.failures.outbox?.attempts ?? 0,
    DeletionsWaiting: report.deletions.waiting,
    HeadsBehind: report.heads.behind.length,
    HeadsUnrepaired: report.heads.unrepaired.length
  };
}

const METRIC_NAMESPACE = '6529/E2eeRelay';

/**
 * Writes the lag in CloudWatch's embedded metric format, one line per run
 * (namespace 6529/E2eeRelay, dimension Environment). Only in a Lambda.
 */
export function emitE2eeRelayLagMetrics(report: E2eeRelayLoopReport): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  const values = e2eeRelayLagMetrics(report);
  process.stdout.write(
    `${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [['Environment']],
            Metrics: Object.keys(values).map((name) => ({
              Name: name,
              Unit: name.endsWith('Seconds') ? 'Seconds' : 'Count'
            }))
          }
        ]
      },
      Environment: (process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')
        ? 'staging'
        : 'prod',
      ...values
    })}\n`
  );
}

/** The loop's production wiring: process settings and the orderer's pool. */
export function defaultE2eeRelayLoopDeps(): E2eeRelayLoopDeps {
  return {
    settings: e2eeRelaySettings,
    publisher: e2eeStreamPublisher,
    store: e2eeStreamStore,
    pool: e2eeDefaultRelayPool,
    now: () => Date.now(),
    metrics: emitE2eeRelayLagMetrics
  };
}
