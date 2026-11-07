import { gunzipSync, gzipSync } from 'node:zlib';
import {
  decryptDiagnostics,
  encryptDiagnostics,
  newDiagnosticsCode
} from '@/api/telemetry/telemetry-diagnostics-crypto';
import {
  DiagnosticsSummary,
  fetchDiagnostics,
  insertDiagnostics
} from '@/api/telemetry/telemetry-diagnostics.db';

/**
 * "Send diagnostics" bundles (C52, R14 §3.6).
 *
 * Request: `{ v: 1, encoding: "gzip" | "identity", data: "<base64>" }`.
 * The decoded data is at most 256 KB; it must decompress to at most 2 MiB of
 * JSON whose top level is an object with `v: 1`. The bundle content is owned
 * and scrubbed by the client and shown to the user before sending. It is
 * stored gzip-compressed and AES-256-GCM encrypted, bound to its short code,
 * and deleted 14 days later. Nothing about the sender (IP, user agent,
 * account) is stored with it.
 */
export const DIAG_MAX_REQUEST_BYTES = 384 * 1024;
export const DIAG_MAX_COMPRESSED_BYTES = 256 * 1024;
export const DIAG_MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
export const DIAG_RETENTION_DAYS = 14;
const MAX_CODE_ATTEMPTS = 5;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export class DiagnosticsInputError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string
  ) {
    super(message);
    // Keeps instanceof working when compiled to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'DiagnosticsInputError';
  }
}

function isOutputLimitError(error: unknown): boolean {
  // zlib reports maxOutputLength as ERR_BUFFER_TOO_LARGE (a RangeError).
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE' ||
      (error as { name?: unknown }).name === 'RangeError')
  );
}

interface DecodedBundle {
  readonly gzip: Buffer;
  readonly uncompressedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length === 0) {
    throw new DiagnosticsInputError(400, 'data must be base64');
  }
  if (data.length > Math.ceil(DIAG_MAX_COMPRESSED_BYTES / 3) * 4) {
    throw new DiagnosticsInputError(413, 'bundle too large');
  }
  if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    throw new DiagnosticsInputError(400, 'data must be base64');
  }
  return Buffer.from(data, 'base64');
}

function inflate(compressed: Buffer): Buffer {
  try {
    return gunzipSync(compressed, {
      maxOutputLength: DIAG_MAX_UNCOMPRESSED_BYTES
    });
  } catch (error) {
    if (isOutputLimitError(error)) {
      throw new DiagnosticsInputError(413, 'bundle too large');
    }
    throw new DiagnosticsInputError(400, 'data is not gzip');
  }
}

function assertBundleJson(json: Buffer) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString('utf8'));
  } catch {
    throw new DiagnosticsInputError(400, 'bundle is not JSON');
  }
  if (!isRecord(parsed) || parsed.v !== 1) {
    throw new DiagnosticsInputError(400, 'bundle must be an object with v: 1');
  }
}

export function decodeDiagnosticsRequest(raw: unknown): DecodedBundle {
  if (!isRecord(raw) || raw.v !== 1) {
    throw new DiagnosticsInputError(400, 'v must be 1');
  }
  if (raw.encoding !== 'gzip' && raw.encoding !== 'identity') {
    throw new DiagnosticsInputError(400, 'encoding must be gzip or identity');
  }
  const decoded = decodeBase64(raw.data);
  if (decoded.length > DIAG_MAX_COMPRESSED_BYTES) {
    throw new DiagnosticsInputError(413, 'bundle too large');
  }
  const json = raw.encoding === 'gzip' ? inflate(decoded) : decoded;
  assertBundleJson(json);
  return {
    gzip: raw.encoding === 'gzip' ? decoded : gzipSync(json),
    uncompressedBytes: json.length
  };
}

export async function storeDiagnostics(
  raw: unknown,
  now: Date
): Promise<{ code: string; expires_at: Date }> {
  const bundle = decodeDiagnosticsRequest(raw);
  const expiresAt = new Date(
    now.getTime() + DIAG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = newDiagnosticsCode();
    const encrypted = encryptDiagnostics(bundle.gzip, code);
    const inserted = await insertDiagnostics({
      code,
      created_at: now,
      expires_at: expiresAt,
      ...encrypted,
      compressed_bytes: bundle.gzip.length,
      uncompressed_bytes: bundle.uncompressedBytes
    });
    if (inserted) {
      return { code, expires_at: expiresAt };
    }
  }
  throw new Error('Could not allocate a diagnostics code');
}

export interface DiagnosticsBundle extends DiagnosticsSummary {
  readonly bundle: Record<string, unknown>;
}

export async function readDiagnostics(
  code: string,
  now: Date
): Promise<DiagnosticsBundle | null> {
  const stored = await fetchDiagnostics(code, now);
  if (!stored) {
    return null;
  }
  const gzip = decryptDiagnostics(stored, stored.code);
  // Bounded like uploads, so a stored row can never inflate without limit.
  const json = gunzipSync(gzip, {
    maxOutputLength: DIAG_MAX_UNCOMPRESSED_BYTES
  }).toString('utf8');
  let bundle: Record<string, unknown>;
  try {
    bundle = JSON.parse(json);
  } catch {
    throw new Error('Stored diagnostics bundle is not valid JSON');
  }
  return {
    code: stored.code,
    created_at: stored.created_at,
    expires_at: stored.expires_at,
    compressed_bytes: stored.compressed_bytes,
    uncompressed_bytes: stored.uncompressed_bytes,
    bundle
  };
}
