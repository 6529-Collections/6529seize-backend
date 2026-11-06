import express, { NextFunction, Request, Response } from 'express';
import { Logger } from '@/logging';
import { getTelemetryViewer } from '@/api/telemetry/telemetry-edge';
import { getTelemetryDailySalt } from '@/api/telemetry/telemetry-daily-salt';
import { isTelemetryRateLimited } from '@/api/telemetry/telemetry-rate-limit';
import { isDiagnosticsEncryptionConfigured } from '@/api/telemetry/telemetry-diagnostics-crypto';
import { deleteExpiredDiagnostics } from '@/api/telemetry/telemetry-diagnostics.db';
import {
  DIAG_MAX_REQUEST_BYTES,
  DiagnosticsInputError,
  storeDiagnostics
} from '@/api/telemetry/telemetry-diagnostics';

/**
 * `POST /api/e/diag` (6529.io/e/diag): stores a user-sent diagnostics bundle
 * and returns its short code. The body, IP and user agent are never logged;
 * the IP is used only in memory for the salted-hash rate limit (5 per hour).
 */
const logger = Logger.get('TELEMETRY_DIAGNOSTICS');

const router = express.Router();

const readBody = express.text({
  type: () => true,
  limit: DIAG_MAX_REQUEST_BYTES
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

export async function handleDiagnosticsUpload(
  req: Request,
  res: Response
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDiagnosticsEncryptionConfigured()) {
    res.status(503).json({ error: 'Diagnostics are not available' });
    return;
  }
  const body = parseJson(req.body);
  if (body === undefined) {
    res.status(400).json({ error: 'Body must be JSON' });
    return;
  }
  const now = new Date();
  const viewer = getTelemetryViewer(req);
  const salt = await getTelemetryDailySalt(now);
  if (await isTelemetryRateLimited('diag', viewer.ip, salt)) {
    res.status(429).json({ error: 'Too many diagnostics bundles' });
    return;
  }
  try {
    const stored = await storeDiagnostics(body, now);
    res.status(201).json({
      code: stored.code,
      expires_at: stored.expires_at.toISOString()
    });
  } catch (error) {
    if (error instanceof DiagnosticsInputError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
  await deleteExpiredDiagnostics(now).catch((error: unknown) => {
    logger.warn(`Expired diagnostics not removed: ${errorName(error)}`);
  });
}

router.post('/', readBody, (req: Request, res: Response) => {
  handleDiagnosticsUpload(req, res).catch((error: unknown) => {
    logger.warn(`Diagnostics bundle not stored: ${errorName(error)}`);
    if (!res.headersSent) {
      res.status(503).json({ error: 'Diagnostics could not be stored' });
    }
  });
});

// Oversized or unreadable bodies end here without reaching the shared error
// handlers, which could report request details.
router.use(
  (
    error: { status?: number },
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    res.setHeader('Cache-Control', 'no-store');
    const status = error?.status === 413 ? 413 : 400;
    res.status(status).json({ error: 'Bundle rejected' });
  }
);

export default router;
