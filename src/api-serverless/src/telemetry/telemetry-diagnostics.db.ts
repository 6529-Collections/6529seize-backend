import { TELEMETRY_DIAGNOSTICS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { DiagnosticsCiphertext } from '@/api/telemetry/telemetry-diagnostics-crypto';

export interface StoredDiagnostics extends DiagnosticsCiphertext {
  readonly code: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly compressed_bytes: number;
  readonly uncompressed_bytes: number;
}

export type DiagnosticsSummary = Omit<
  StoredDiagnostics,
  'key_id' | 'iv' | 'auth_tag' | 'ciphertext'
>;

/** Inserts a bundle. Returns false when the code is already taken. */
export async function insertDiagnostics(
  row: StoredDiagnostics
): Promise<boolean> {
  const result = await sqlExecutor.execute(
    `INSERT IGNORE INTO ${TELEMETRY_DIAGNOSTICS_TABLE}
       (code, created_at, expires_at, key_id, iv, auth_tag, ciphertext,
        compressed_bytes, uncompressed_bytes)
     VALUES (:code, :created_at, :expires_at, :key_id, :iv, :auth_tag,
        :ciphertext, :compressed_bytes, :uncompressed_bytes)`,
    { ...row }
  );
  return sqlExecutor.getAffectedRows(result) === 1;
}

export async function fetchDiagnostics(
  code: string,
  now: Date
): Promise<StoredDiagnostics | null> {
  return sqlExecutor.oneOrNull<StoredDiagnostics>(
    `SELECT code, created_at, expires_at, key_id, iv, auth_tag, ciphertext,
            compressed_bytes, uncompressed_bytes
     FROM ${TELEMETRY_DIAGNOSTICS_TABLE}
     WHERE code = :code AND expires_at > :now`,
    { code, now }
  );
}

export async function listDiagnostics(
  now: Date,
  limit: number
): Promise<DiagnosticsSummary[]> {
  return sqlExecutor.execute<DiagnosticsSummary>(
    `SELECT code, created_at, expires_at, compressed_bytes, uncompressed_bytes
     FROM ${TELEMETRY_DIAGNOSTICS_TABLE}
     WHERE expires_at > :now
     ORDER BY created_at DESC
     LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`,
    { now }
  );
}

/** Hard-deletes expired bundles. Returns the number removed. */
export async function deleteExpiredDiagnostics(now: Date): Promise<number> {
  const result = await sqlExecutor.execute(
    `DELETE FROM ${TELEMETRY_DIAGNOSTICS_TABLE} WHERE expires_at <= :now`,
    { now }
  );
  return sqlExecutor.getAffectedRows(result);
}
