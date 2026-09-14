import { rename, writeFile } from 'node:fs/promises';
import { WalletTransferAnalysisError } from '@/wallet-transfer-analysis/types';

const RETRY_DELAYS_MS = [50, 100, 200];
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const DIAGNOSTIC_CODES = new Set([
  ...Array.from(RETRYABLE_CODES),
  'ENOSPC',
  'EROFS',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EMFILE',
  'ENFILE',
  'EIO'
]);

function filesystemErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return typeof code === 'string' && DIAGNOSTIC_CODES.has(code)
    ? code
    : 'UNKNOWN';
}

async function retryStateFileOperation(
  operation: 'state temporary write' | 'state replace',
  work: () => Promise<void>
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await work();
      return;
    } catch (error) {
      const code = filesystemErrorCode(error);
      const delay = RETRY_DELAYS_MS[attempt];
      if (!RETRYABLE_CODES.has(code) || delay === undefined) {
        throw new WalletTransferAnalysisError(
          `Backfill ${operation} failed (${code})`
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Atomically replaces local state, retrying only bounded filesystem conflicts. */
export async function saveBackfillState(
  path: string,
  state: { updated_at: number }
): Promise<void> {
  state.updated_at = Date.now();
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  const temporaryPath = `${path}.tmp`;
  await retryStateFileOperation('state temporary write', () =>
    writeFile(temporaryPath, contents, { mode: 0o600 })
  );
  await retryStateFileOperation('state replace', () =>
    rename(temporaryPath, path)
  );
}
