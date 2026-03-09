import {
  getPayloadPreview,
  normalizeMetadataPayload
} from '@/metadata-payload';

const METADATA_FETCH_TIMEOUT_MS = 30000;

export async function fetchNextGenMetadata(
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
      throw new Error(
        `Metadata fetch timed out for ${metadataLink} after ${METADATA_FETCH_TIMEOUT_MS}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const body = await res.text();
  if (res.ok === false || res.status >= 400) {
    throw new Error(
      `Metadata fetch failed for ${metadataLink} with status ${res.status}`
    );
  }

  const metadata = normalizeMetadataPayload(body);
  if (!metadata) {
    const contentType = res.headers.get('content-type') ?? 'unknown';
    const preview = getPayloadPreview(body);
    throw new Error(
      `Invalid metadata payload for ${metadataLink} (content-type: ${contentType}, preview: ${preview})`
    );
  }
  return metadata;
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
