import { createHash } from 'node:crypto';
import type { RedisClientType } from 'redis';
import { sanitizeAlertText } from '@/api/alerts/alert-text';

const SENTRY_ALERT_DROP_MAX_CONTENT_LENGTH = 30000;
const SENTRY_ALERT_DROP_MAX_TITLE_LENGTH = 250;
export const SENTRY_WEBHOOK_DEDUPE_TTL_SECONDS = 86400;
export const SENTRY_WEBHOOK_PROCESSING_LOCK_TTL_SECONDS = 300;

export interface SentryAlertDrop {
  title: string;
  content: string;
  eventId: string | null;
  issueId: string | null;
  level: string;
  webUrl: string | null;
}

/** The Redis commands the webhook needs. */
export interface SentryWebhookRedis {
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    options: { NX?: boolean; EX: number }
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Narrows the shared client to the commands used here. */
export function sentryWebhookRedis(
  client: RedisClientType | null
): SentryWebhookRedis | null {
  if (!client) {
    return null;
  }
  return {
    get: (key) => client.get(key),
    set: (key, value, options) =>
      options.NX
        ? client.set(key, value, { NX: true, EX: options.EX })
        : client.set(key, value, { EX: options.EX }),
    del: (key) => client.del(key)
  };
}

interface WebhookLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SentryWebhookResult {
  status: number;
  body: unknown;
}

function normalizeToString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/** A provider string made safe for drop markup; null when empty. */
function safeText(value: unknown): string | null {
  const normalized = normalizeToString(value);
  if (!normalized) {
    return null;
  }
  const sanitized = sanitizeAlertText(normalized);
  return sanitized.length > 0 ? sanitized : null;
}

/** Text placed inside a code fence: no backticks, so it cannot close it. */
function fencedLine(value: string): string {
  return sanitizeAlertText(value).replace(/`/g, "'");
}

function safeUrl(value: unknown): string | null {
  const normalized = normalizeToString(value);
  if (!normalized) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'https:'
      ? sanitizeAlertText(parsed.toString())
      : null;
  } catch {
    return null;
  }
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.substring(0, maxLength - 3)}...`;
}

function formatSentryException(event: any): string | null {
  const entries = Array.isArray(event?.entries) ? event.entries : [];
  const exceptionEntry = entries.find(
    (entry: any) => entry?.type === 'exception'
  );
  const exception = exceptionEntry?.data?.values?.[0];
  if (!exception) {
    return null;
  }

  const exceptionType = normalizeToString(exception.type);
  const exceptionValue = normalizeToString(exception.value);
  const stackFrames = Array.isArray(exception?.stacktrace?.frames)
    ? exception.stacktrace.frames
    : [];
  const latestFrame =
    stackFrames.length > 0 ? stackFrames[stackFrames.length - 1] : null;
  const frameFunction = normalizeToString(latestFrame?.function);
  const frameFile = normalizeToString(latestFrame?.filename);
  const frameLine = normalizeToString(latestFrame?.lineno);
  const location = [frameFile, frameLine].filter(Boolean).join(':');

  const lines = [];
  if (exceptionType || exceptionValue) {
    lines.push([exceptionType, exceptionValue].filter(Boolean).join(': '));
  }
  if (frameFunction && location) {
    lines.push(`at ${frameFunction} (${location})`);
  } else if (frameFunction) {
    lines.push(`at ${frameFunction}`);
  } else if (location) {
    lines.push(`at ${location}`);
  }
  if (!lines.length) {
    return null;
  }
  return truncateString(lines.map(fencedLine).join('\n'), 2000);
}

/**
 * Builds the alert drop for a Sentry event. Every provider string is
 * sanitised like CI alerts (no mention or link markup), and the exception
 * preview cannot escape its code fence.
 */
export function formatSentryAlertForDrop(payload: any): SentryAlertDrop {
  const event = payload?.data?.event ?? {};
  const level = (safeText(event.level) ?? 'error').toUpperCase();
  const eventTitle =
    safeText(event.title) ?? safeText(event.message) ?? 'Sentry alert';
  const issueId = safeText(event.issue_id);
  const eventId = normalizeToString(event.event_id);
  const safeEventId = safeText(event.event_id);
  const project =
    safeText(event.project_slug) ??
    safeText(event.project_name) ??
    safeText(event.project);
  const environment = safeText(event.environment);
  const culprit = safeText(event.culprit);
  const loggerName = safeText(event.logger);
  const transaction = safeText(event.transaction);
  const message = safeText(event.message);
  const webUrl = safeUrl(event.web_url) ?? safeUrl(payload?.data?.issue?.url);
  const exceptionPreview = formatSentryException(event);

  const titlePrefix = project
    ? `Sentry ${level} | ${project}`
    : `Sentry ${level}`;
  const title = truncateString(
    `${titlePrefix}: ${eventTitle}`,
    SENTRY_ALERT_DROP_MAX_TITLE_LENGTH
  );

  const lines = [`**${eventTitle}**`, '', `- Level: ${level}`];
  const details: [string, string | null][] = [
    ['Project', project],
    ['Environment', environment],
    ['Issue ID', issueId],
    ['Event ID', safeEventId],
    ['Culprit', culprit],
    ['Logger', loggerName],
    ['Transaction', transaction],
    ['URL', webUrl]
  ];
  for (const [label, value] of details) {
    if (value) {
      lines.push(`- ${label}: ${value}`);
    }
  }
  if (message && message !== eventTitle) {
    lines.push(`- Message: ${message}`);
  }
  if (exceptionPreview) {
    lines.push('', '**Exception**', '```', exceptionPreview, '```');
  }

  const content = truncateString(
    lines.join('\n'),
    SENTRY_ALERT_DROP_MAX_CONTENT_LENGTH
  );

  return { title, content, eventId, issueId, level, webUrl };
}

// Sentry event ids are 32 hex characters; anything else is hashed so the
// key stays short.
function eventKeyPart(eventId: string): string {
  return /^[A-Za-z0-9-]{1,64}$/.test(eventId)
    ? eventId
    : createHash('sha256').update(eventId).digest('hex');
}

function sentryDedupeKeys(
  alert: SentryAlertDrop,
  rawBody: Buffer
): { processed: string[]; lock: string } {
  const bodyHash = createHash('sha256')
    .update(new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.length))
    .digest('hex');
  const bodyKey = `sentry-webhook:body:${bodyHash}`;
  const eventKey = alert.eventId
    ? `sentry-webhook:${eventKeyPart(alert.eventId)}`
    : null;
  return {
    processed: eventKey ? [eventKey, bodyKey] : [bodyKey],
    lock: `${eventKey ?? bodyKey}:processing`
  };
}

const NOTHING_TO_DO: SentryWebhookResult = { status: 200, body: {} };
const DEDUPE_UNAVAILABLE: SentryWebhookResult = {
  status: 503,
  body: 'Alert deduplication unavailable'
};

/**
 * Handles a verified Sentry alert webhook. A payload is posted at most once
 * per event id and per identical body within the dedupe window. Without
 * Redis nothing is posted (503) rather than posting without deduplication.
 */
export async function processSentryAlertWebhook({
  body,
  rawBody,
  redis,
  postDrop,
  logger
}: {
  body: any;
  rawBody: Buffer;
  redis: SentryWebhookRedis | null;
  postDrop: (drop: { title: string; content: string }) => Promise<void>;
  logger: WebhookLogger;
}): Promise<SentryWebhookResult> {
  if (body?.action !== 'triggered') {
    return NOTHING_TO_DO;
  }
  const alert = formatSentryAlertForDrop(body);
  if (!redis) {
    logger.warn('Redis unavailable; Sentry alert not posted');
    return DEDUPE_UNAVAILABLE;
  }
  const keys = sentryDedupeKeys(alert, rawBody);
  try {
    for (const key of keys.processed) {
      if (await redis.get(key)) {
        logger.info('Duplicate Sentry webhook, skipping');
        return NOTHING_TO_DO;
      }
    }
    const lockWasSet = await redis.set(keys.lock, '1', {
      NX: true,
      EX: SENTRY_WEBHOOK_PROCESSING_LOCK_TTL_SECONDS
    });
    if (!lockWasSet) {
      logger.info('Sentry webhook is already being processed, skipping');
      return NOTHING_TO_DO;
    }
  } catch (err) {
    logger.warn(`Sentry webhook dedupe check failed: ${err}`);
    return DEDUPE_UNAVAILABLE;
  }

  logger.info(
    `Sentry alert received [level ${alert.level}] [issue ${
      alert.issueId ?? 'unknown'
    }] [event ${eventKeyPart(alert.eventId ?? 'unknown')}] [url ${
      alert.webUrl ?? 'n/a'
    }]`
  );
  try {
    await postDrop({ title: alert.title, content: alert.content });
    for (const key of keys.processed) {
      try {
        await redis.set(key, '1', { EX: SENTRY_WEBHOOK_DEDUPE_TTL_SECONDS });
      } catch (err) {
        logger.warn(`Failed to persist Sentry dedupe key: ${err}`);
      }
    }
    return NOTHING_TO_DO;
  } catch (err) {
    logger.error(`Failed to post Sentry alert drop: ${err}`);
    return { status: 500, body: 'Failed to post alert' };
  } finally {
    try {
      await redis.del(keys.lock);
    } catch (err) {
      logger.warn(`Failed to release Sentry processing lock: ${err}`);
    }
  }
}
