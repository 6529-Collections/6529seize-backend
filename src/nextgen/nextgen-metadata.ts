import {
  getPayloadPreview,
  normalizeMetadataPayload
} from '@/metadata-payload';

const METADATA_FETCH_TIMEOUT_MS = 30000;
const METADATA_FETCH_ATTEMPTS = 3;
const METADATA_FETCH_RETRY_BASE_DELAY_MS = 500;

const RETRYABLE_STATUS_CODES = new Set([408, 429]);

export class NextGenMetadataFetchError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number
  ) {
    super(message);
    Object.setPrototypeOf(this, NextGenMetadataFetchError.prototype);
  }
}

export async function fetchNextGenMetadata(
  metadataLink: string
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= METADATA_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchNextGenMetadataOnce(metadataLink);
    } catch (error: unknown) {
      lastError = error;
      if (
        !isRetryableMetadataFetchError(error) ||
        attempt === METADATA_FETCH_ATTEMPTS
      ) {
        throw error;
      }
      await sleep(retryDelayMs(attempt));
    }
  }

  throw lastError;
}

async function fetchNextGenMetadataOnce(
  metadataLink: string
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    METADATA_FETCH_TIMEOUT_MS
  );

  let res: Response;
  try {
    res = await fetch(metadataLink, { signal: controller.signal });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NextGenMetadataFetchError(
        `Metadata fetch timed out for ${metadataLink} after ${METADATA_FETCH_TIMEOUT_MS}ms`,
        true
      );
    }
    throw new NextGenMetadataFetchError(
      `Metadata fetch failed for ${metadataLink}: ${errorMessage(error)}`,
      true
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const body = await res.text();
  if (res.ok === false || res.status >= 400) {
    throw new NextGenMetadataFetchError(
      `Metadata fetch failed for ${metadataLink} with status ${res.status}`,
      isRetryableStatus(res.status),
      res.status
    );
  }

  const metadata = normalizeMetadataPayload(body);
  if (!metadata) {
    const contentType = res.headers.get('content-type') ?? 'unknown';
    const preview = getPayloadPreview(body);
    throw new NextGenMetadataFetchError(
      `Invalid metadata payload for ${metadataLink} (content-type: ${contentType}, preview: ${preview})`,
      false
    );
  }
  return metadata;
}

export function isRetryableMetadataFetchError(error: unknown): boolean {
  return error instanceof NextGenMetadataFetchError && error.retryable;
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

function retryDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 0;
  return METADATA_FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getRequiredMetadataName(
  metadata: Record<string, unknown>,
  metadataLink: string
): string {
  const name = metadata.name;
  if (typeof name !== 'string') {
    throw new TypeError(`Invalid metadata.name for ${metadataLink}`);
  }
  return name;
}
