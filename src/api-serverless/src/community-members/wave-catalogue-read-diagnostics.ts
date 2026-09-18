import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { loggerContext } from '@/logger-context';
import { getRedisConnectionEventCounts } from '@/redis';

const LOG_PREFIX = '[WAVE_CATALOGUE_READ]';
const MAX_SAMPLES_PER_MINUTE = 60;
const MAX_SIMULTANEOUS_MONITORS = 8;
const EVENT_LOOP_RESOLUTION_MS = 20;

let activeReads = 0;
let activeMonitors = 0;
let sampleWindowStartMs = 0;
let samplesInWindow = 0;
const activeSamples = new Set<{ maxConcurrentReads: number }>();

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
  if (samplesInWindow >= MAX_SAMPLES_PER_MINUTE || Math.random() >= rate) {
    return false;
  }
  samplesInWindow++;
  return true;
}

function milliseconds(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

/** One process-local observation of the real GET and hit parsing path. */
export async function readWaveCatalogueWithDiagnostics<T>(
  client: { readonly isReady?: boolean; readonly isOpen?: boolean },
  get: () => Promise<string | null>,
  parse: (raw: string) => T
): Promise<{ hit: true; value: T } | { hit: false }> {
  const sampled = shouldSample();
  activeReads++;
  const sample = sampled
    ? { concurrentReadsAtStart: activeReads, maxConcurrentReads: activeReads }
    : null;
  activeSamples.forEach((current) => {
    current.maxConcurrentReads = Math.max(
      current.maxConcurrentReads,
      activeReads
    );
  });
  if (sample) {
    activeSamples.add(sample);
  }

  const startedReady = sample ? (client.isReady ?? null) : null;
  const startedOpen = sample ? (client.isOpen ?? null) : null;
  const startingEvents = sampled ? getRedisConnectionEventCounts() : null;
  let monitor: ReturnType<typeof monitorEventLoopDelay> | undefined;
  if (sample && activeMonitors < MAX_SIMULTANEOUS_MONITORS) {
    try {
      const created = monitorEventLoopDelay({
        resolution: EVENT_LOOP_RESOLUTION_MS
      });
      created.enable();
      monitor = created;
      activeMonitors++;
    } catch {
      // Diagnostic setup must not affect eligibility.
    }
  }

  let getMs: number | null = null;
  let parseMs: number | null = null;
  let bytes: number | null = null;
  let outcome: 'hit' | 'miss' | 'error' = 'error';
  let errorStage: 'get' | 'parse' | null = 'get';
  try {
    const getStart = sampled ? performance.now() : 0;
    let raw: string | null;
    try {
      raw = await get();
    } finally {
      if (sampled) {
        getMs = milliseconds(getStart);
      }
      if (monitor) {
        monitor.disable();
        activeMonitors--;
      }
    }
    if (!raw) {
      outcome = 'miss';
      errorStage = null;
      bytes = 0;
      return { hit: false };
    }

    errorStage = 'parse';
    if (sampled) {
      bytes = Buffer.byteLength(raw, 'utf8');
    }
    const parseStart = sampled ? performance.now() : 0;
    try {
      const value = parse(raw);
      outcome = 'hit';
      errorStage = null;
      return { hit: true, value };
    } finally {
      if (sampled) {
        parseMs = milliseconds(parseStart);
      }
    }
  } finally {
    if (sample) {
      activeSamples.delete(sample);
      const endingEvents = getRedisConnectionEventCounts();
      try {
        // Direct structured output avoids the Logger prefix's jwtSub field.
        process.stdout.write(
          `${LOG_PREFIX} ${JSON.stringify({
            request_id: loggerContext.get()?.requestId ?? null,
            cache_outcome: outcome,
            error_stage: errorStage,
            catalogue_bytes: bytes,
            get_ms: getMs,
            parse_ms: parseMs,
            concurrent_reads_at_start: sample.concurrentReadsAtStart,
            max_concurrent_reads_during_read: sample.maxConcurrentReads,
            redis_ready_start: startedReady,
            redis_ready_end: client.isReady ?? null,
            redis_open_start: startedOpen,
            redis_open_end: client.isOpen ?? null,
            redis_ready_events_during_read:
              endingEvents.ready - startingEvents!.ready,
            redis_reconnect_events_during_read:
              endingEvents.reconnecting - startingEvents!.reconnecting,
            event_loop_delay_samples: monitor ? Number(monitor.count) : 0,
            event_loop_delay_max_ms:
              monitor && Number(monitor.count) > 0
                ? Math.round((monitor.max / 1e6) * 1000) / 1000
                : null
          })}\n`
        );
      } catch {
        // Logging must not change cache or permission behavior.
      }
    }
    activeReads--;
  }
}
