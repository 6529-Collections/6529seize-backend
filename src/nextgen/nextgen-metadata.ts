import {
  getPayloadPreview,
  normalizeMetadataPayload
} from '@/metadata-payload';

export async function fetchNextGenMetadata(
  metadataLink: string
): Promise<Record<string, unknown>> {
  const res = await fetch(metadataLink);
  const body = await res.text();
  const hasOk = typeof res?.ok === 'boolean';
  const hasErrorStatus =
    typeof res?.status === 'number' && Number(res.status) >= 400;
  if ((hasOk && !res.ok) || hasErrorStatus) {
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
    throw new Error(`Invalid metadata.name for ${metadataLink}`);
  }
  return name;
}
