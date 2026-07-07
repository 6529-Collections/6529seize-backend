import { Logger } from '@/logging';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;

type DbErrorLike = {
  cause?: unknown;
  code?: unknown;
  driverError?: unknown;
  errno?: unknown;
  message?: unknown;
};

type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  logger?: Pick<Logger, 'warn'>;
  operation: string;
  sleep?: (ms: number) => Promise<void>;
};

export async function withNextgenDbLockRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      if (!isRetryableDbLockError(error) || attempt === attempts) {
        throw error;
      }

      options.logger?.warn(
        `[NEXTGEN DB LOCK RETRY] [OPERATION ${options.operation}] [ATTEMPT ${attempt}/${attempts}] [ERROR ${errorMessage(error)}]`
      );
      await (options.sleep ?? sleep)(
        retryDelayMs(attempt, options.baseDelayMs)
      );
    }
  }

  throw lastError;
}

export function isRetryableDbLockError(error: unknown): boolean {
  return errorCandidates(error).some((candidate) => {
    const code = String(candidate.code ?? '');
    const errno = Number(candidate.errno);
    const message = String(candidate.message ?? '');

    return (
      code === 'ER_LOCK_DEADLOCK' ||
      code === 'ER_LOCK_WAIT_TIMEOUT' ||
      errno === 1213 ||
      errno === 1205 ||
      message.includes('Deadlock found when trying to get lock') ||
      message.includes('Lock wait timeout exceeded')
    );
  });
}

function errorCandidates(error: unknown): DbErrorLike[] {
  const candidates: DbErrorLike[] = [];
  const seen = new Set<unknown>();
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 5 || seen.has(candidate)) return;
    seen.add(candidate);
    const errorLike = toDbErrorLike(candidate);
    candidates.push(errorLike);
    visit(errorLike.driverError, depth + 1);
    visit(errorLike.cause, depth + 1);
  };

  visit(error, 0);
  return candidates;
}

function toDbErrorLike(error: unknown): DbErrorLike {
  if (typeof error === 'object' && error !== null) {
    return error as DbErrorLike;
  }
  return { message: String(error) };
}

function retryDelayMs(attempt: number, baseDelayMs?: number): number {
  return (baseDelayMs ?? DEFAULT_BASE_DELAY_MS) * 2 ** (attempt - 1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
