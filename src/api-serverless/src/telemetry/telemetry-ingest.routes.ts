import express, { NextFunction, Request, Response } from 'express';
import { Logger } from '@/logging';
import { TELEMETRY_MAX_BATCH_BYTES } from '@/api/telemetry/telemetry.schema';
import {
  sanitizeTelemetryBatch,
  TelemetryEvent
} from '@/api/telemetry/telemetry-sanitizer';
import { aggregateTelemetryEvents } from '@/api/telemetry/telemetry-aggregation';
import { writeTelemetryIncrements } from '@/api/telemetry/telemetry.db';
import {
  getTelemetryViewer,
  TelemetryViewer
} from '@/api/telemetry/telemetry-edge';
import {
  getTelemetryDailySalt,
  TelemetryDailySalt
} from '@/api/telemetry/telemetry-daily-salt';
import { isTelemetryRateLimited } from '@/api/telemetry/telemetry-rate-limit';
import { maybeRunTelemetryDailyJobs } from '@/api/telemetry/telemetry-retention';
import {
  maybeFlushAnonymousVisitors,
  recordAnonymousVisitors
} from '@/api/telemetry/telemetry-uniques';

/**
 * First-party telemetry collector, mounted at `/api/e` ahead of the global
 * JSON parser and rate limiter (6529.io/e reaches it through CloudFront).
 *
 * Privacy contract (C52):
 * - the request body, IP address, user agent and `fp` are never logged;
 * - only sanitized daily counters are stored (no raw events, no IPs);
 * - errors are logged by error name only.
 */
const logger = Logger.get('TELEMETRY_INGEST');

const router = express.Router();

// sendBeacon posts strings as text/plain; fetch may use application/json.
// The body is parsed here as text so any content type is accepted.
// Compressed request bodies are refused (415 -> 400): beacons are never
// compressed, and an unauthenticated route should not inflate input.
const readBatchBody = express.text({
  type: () => true,
  limit: TELEMETRY_MAX_BATCH_BYTES,
  inflate: false
});

function parseJson(body: unknown): unknown {
  if (typeof body !== 'string' || body.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/** Daily uniques are best effort: a Redis hiccup never fails the beacon. */
async function recordUniques(
  events: TelemetryEvent[],
  viewer: TelemetryViewer,
  salt: TelemetryDailySalt,
  now: Date
): Promise<void> {
  try {
    await recordAnonymousVisitors(events, viewer, salt, now);
    await maybeFlushAnonymousVisitors(now);
  } catch (error) {
    logger.warn(`Telemetry uniques not recorded: ${errorName(error)}`);
  }
}

export async function handleTelemetryBatch(
  req: Request,
  res: Response
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const text = typeof req.body === 'string' ? req.body : '';
  if (text.trim() === '') {
    // An empty beacon is a no-op, like a batch whose events are all dropped.
    res.status(204).end();
    return;
  }
  const batch = parseJson(text);
  if (batch === undefined) {
    res.status(400).end();
    return;
  }
  const now = new Date();
  const viewer = getTelemetryViewer(req);
  const salt = await getTelemetryDailySalt(now);
  if (await isTelemetryRateLimited('ingest', viewer.ip, salt)) {
    res.status(429).end();
    return;
  }
  const events = sanitizeTelemetryBatch(batch);
  if (events.length > 0) {
    const increments = aggregateTelemetryEvents(events, {
      country: viewer.country,
      hour: now.getUTCHours()
    });
    await writeTelemetryIncrements(salt.day, increments);
  }
  await recordUniques(events, viewer, salt, now);
  await maybeRunTelemetryDailyJobs(now);
  res.status(204).end();
}

router.post('/', readBatchBody, (req: Request, res: Response) => {
  handleTelemetryBatch(req, res).catch((error: unknown) => {
    logger.warn(`Telemetry batch not recorded: ${errorName(error)}`);
    if (!res.headersSent) {
      res.status(503).end();
    }
  });
});

// Body parser failures (oversized or unreadable bodies) end here, without
// reaching the shared error handlers, which could report request details.
router.use(
  (
    error: { status?: number; type?: string },
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(error?.status === 413 ? 413 : 400).end();
  }
);

export default router;
