import { randomInt } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { loggerContext } from '@/logger-context';
import { getRedisConnectionEventCounts } from '@/redis';

const LOG_PREFIX = '[WAVE_CATALOGUE_READ]';
const MAX_SAMPLES_PER_MINUTE = 60;
const MAX_SIMULTANEOUS_MONITORS = 8;
const EVENT_LOOP_RESOLUTION_MS = 20;
const RANDOM_SCALE = 1_000_000;

type CatalogueClient = {
  readonly isReady?: boolean;
  readonly isOpen?: boolean;
};
type ConnectionEvents = ReturnType<typeof getRedisConnectionEventCounts>;
type Outcome = 'hit' | 'miss' | 'error';
type ErrorStage = 'get' | 'parse' | null;

interface ReadSample {
  readonly concurrentReadsAtStart: number;
  maxConcurrentReads: number;
  readonly readyStart: boolean | null;
  readonly openStart: boolean | null;
  readonly startingEvents: ConnectionEvents;
  monitor?: ReturnType<typeof monitorEventLoopDelay>;
  getMs: number | null;
  parseMs: number | null;
  bytes: number | null;
  outcome: Outcome;
  errorStage: ErrorStage;
}

let activeReads = 0;
let activeMonitors = 0;
let sampleWindowStartMs = 0;
let samplesInWindow = 0;
const activeSamples = new Set<ReadSample>();

function shouldSample(): boolean {
  const rate = Number(process.env.WAVE_CATALOGUE_READ_SAMPLE_RATE ?? '0');
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
    return false;
  }
  const now = Date.now();
  if (now < sampleWindowStartMs || now - sampleWindowStartMs >= 60_000) {
    sampleWindowStartMs = now;
    samplesInWindow = 0;
  }
  if (
    samplesInWindow >= MAX_SAMPLES_PER_MINUTE ||
    randomInt(RANDOM_SCALE) >= rate * RANDOM_SCALE
  ) {
    return false;
  }
  samplesInWindow++;
  return true;
}

function milliseconds(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

function startMonitor(): ReturnType<typeof monitorEventLoopDelay> | undefined {
  if (activeMonitors >= MAX_SIMULTANEOUS_MONITORS) {
    return undefined;
  }
  try {
    const monitor = monitorEventLoopDelay({
      resolution: EVENT_LOOP_RESOLUTION_MS
    });
    monitor.enable();
    activeMonitors++;
    return monitor;
  } catch {
    return undefined;
  }
}

function stopMonitor(sample: ReadSample): void {
  if (!sample.monitor) {
    return;
  }
  try {
    sample.monitor.disable();
  } catch {
    // Monitor failure must not replace the GET result or error.
  } finally {
    activeMonitors--;
  }
}

function startSample(client: CatalogueClient): ReadSample | null {
  if (!shouldSample()) {
    return null;
  }
  try {
    const sample: ReadSample = {
      concurrentReadsAtStart: activeReads,
      maxConcurrentReads: activeReads,
      readyStart: client.isReady ?? null,
      openStart: client.isOpen ?? null,
      startingEvents: getRedisConnectionEventCounts(),
      getMs: null,
      parseMs: null,
      bytes: null,
      outcome: 'error',
      errorStage: 'get'
    };
    sample.monitor = startMonitor();
    activeSamples.add(sample);
    return sample;
  } catch {
    // Diagnostic setup must not affect eligibility.
    return null;
  }
}

async function getCatalogueRaw(
  get: () => Promise<string | null>,
  sample: ReadSample | null
): Promise<string | null> {
  const started = sample ? performance.now() : 0;
  try {
    return await get();
  } finally {
    if (sample) {
      sample.getMs = milliseconds(started);
      stopMonitor(sample);
    }
  }
}

function logSample(client: CatalogueClient, sample: ReadSample): void {
  try {
    const endingEvents = getRedisConnectionEventCounts();
    // Direct structured output avoids the Logger prefix's jwtSub field.
    process.stdout.write(
      `${LOG_PREFIX} ${JSON.stringify({
        request_id: loggerContext.get()?.requestId ?? null,
        cache_outcome: sample.outcome,
        error_stage: sample.errorStage,
        catalogue_bytes: sample.bytes,
        get_ms: sample.getMs,
        parse_ms: sample.parseMs,
        concurrent_reads_at_start: sample.concurrentReadsAtStart,
        max_concurrent_reads_during_read: sample.maxConcurrentReads,
        redis_ready_start: sample.readyStart,
        redis_ready_end: client.isReady ?? null,
        redis_open_start: sample.openStart,
        redis_open_end: client.isOpen ?? null,
        redis_ready_events_during_read:
          endingEvents.ready - sample.startingEvents.ready,
        redis_reconnect_events_during_read:
          endingEvents.reconnecting - sample.startingEvents.reconnecting,
        event_loop_monitor_active: sample.monitor !== undefined,
        event_loop_delay_samples: sample.monitor
          ? Number(sample.monitor.count)
          : 0,
        event_loop_delay_max_ms:
          sample.monitor && Number(sample.monitor.count) > 0
            ? Math.round((sample.monitor.max / 1e6) * 1000) / 1000
            : null
      })}\n`
    );
  } catch {
    // Logging must not change cache or permission behavior.
  }
}

/** One process-local observation of the real GET and hit parsing path. */
export async function readWaveCatalogueWithDiagnostics<T>(
  client: CatalogueClient,
  get: () => Promise<string | null>,
  parse: (raw: string) => T
): Promise<{ hit: true; value: T } | { hit: false }> {
  activeReads++;
  activeSamples.forEach((sample) => {
    sample.maxConcurrentReads = Math.max(
      sample.maxConcurrentReads,
      activeReads
    );
  });
  const sample = startSample(client);
  try {
    const raw = await getCatalogueRaw(get, sample);
    if (!raw) {
      if (sample) {
        sample.outcome = 'miss';
        sample.errorStage = null;
        sample.bytes = 0;
      }
      return { hit: false };
    }

    if (sample) {
      sample.errorStage = 'parse';
      sample.bytes = Buffer.byteLength(raw, 'utf8');
    }
    const parseStart = sample ? performance.now() : 0;
    try {
      const value = parse(raw);
      if (sample) {
        sample.outcome = 'hit';
        sample.errorStage = null;
      }
      return { hit: true, value };
    } finally {
      if (sample) {
        sample.parseMs = milliseconds(parseStart);
      }
    }
  } finally {
    if (sample) {
      activeSamples.delete(sample);
      logSample(client, sample);
    }
    activeReads--;
  }
}
