import * as Joi from 'joi';
import { ApiTelemetryDiagnosticsBundle } from '@/api/generated/models/ApiTelemetryDiagnosticsBundle';
import { ApiTelemetryDiagnosticsPage } from '@/api/generated/models/ApiTelemetryDiagnosticsPage';
import {
  GetTelemetryDiagnosticsBundleRequest,
  ListTelemetryDiagnosticsRequest
} from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { NotFoundException } from '@/exceptions';
import { Logger } from '@/logging';
import { assertTelemetryTeamMember } from '@/api/telemetry/telemetry-team-auth';
import { normalizeDiagnosticsCode } from '@/api/telemetry/telemetry-diagnostics-crypto';
import { listDiagnostics } from '@/api/telemetry/telemetry-diagnostics.db';
import { readDiagnostics } from '@/api/telemetry/telemetry-diagnostics';

const logger = Logger.get('TELEMETRY_DIAGNOSTICS_READ');

const ListQuerySchema = Joi.object<{ limit: number }>({
  limit: Joi.number().integer().min(1).max(200).default(50)
}).unknown(false);

function setPrivateHeaders(req: {
  res?: { setHeader: (k: string, v: string) => unknown };
}) {
  req.res?.setHeader('Cache-Control', 'private, no-store');
  req.res?.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

export async function handleListTelemetryDiagnostics(
  req: ListTelemetryDiagnosticsRequest
): Promise<ApiTelemetryDiagnosticsPage> {
  assertTelemetryTeamMember(req);
  setPrivateHeaders(req);
  const { limit } = getValidatedByJoiOrThrow(req.query, ListQuerySchema);
  const rows = await listDiagnostics(new Date(), limit);
  return {
    data: rows.map((row) => ({
      code: row.code,
      created_at: new Date(row.created_at),
      expires_at: new Date(row.expires_at),
      compressed_bytes: Number(row.compressed_bytes),
      uncompressed_bytes: Number(row.uncompressed_bytes)
    }))
  };
}

export async function handleGetTelemetryDiagnosticsBundle(
  req: GetTelemetryDiagnosticsBundleRequest
): Promise<ApiTelemetryDiagnosticsBundle> {
  const wallet = assertTelemetryTeamMember(req);
  setPrivateHeaders(req);
  const code = normalizeDiagnosticsCode(String(req.params.code ?? ''));
  const found = code ? await readDiagnostics(code, new Date()) : null;
  if (!found) {
    throw new NotFoundException('Diagnostics bundle not found or expired');
  }
  // Access audit: which team wallet opened which code. Never the content.
  logger.info(`Diagnostics bundle ${found.code} read by team wallet ${wallet}`);
  return {
    code: found.code,
    created_at: new Date(found.created_at),
    expires_at: new Date(found.expires_at),
    compressed_bytes: Number(found.compressed_bytes),
    uncompressed_bytes: Number(found.uncompressed_bytes),
    bundle: found.bundle
  };
}
