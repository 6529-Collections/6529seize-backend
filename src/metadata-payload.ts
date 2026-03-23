export type MetadataPayload = Record<string, unknown>;

export function isPlainObject(v: unknown): v is MetadataPayload {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getPayloadPreview(payload: unknown, maxLen = 140): string {
  if (typeof payload === 'string') {
    return payload.replace(/\s+/g, ' ').slice(0, maxLen);
  }

  try {
    return JSON.stringify(payload).slice(0, maxLen);
  } catch {
    return String(payload).slice(0, maxLen);
  }
}

export function normalizeMetadataPayload(
  payload: unknown
): MetadataPayload | null {
  if (isPlainObject(payload)) return normalizeNestedMetadataFields(payload);
  if (typeof payload !== 'string') return null;

  const trimmed = payload.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? normalizeNestedMetadataFields(parsed) : null;
  } catch {
    return null;
  }
}

function normalizeNestedMetadataFields(
  payload: MetadataPayload
): MetadataPayload {
  const normalized = { ...payload };
  normalized.animation_details = normalizePossiblyStringifiedObject(
    normalized.animation_details
  );
  return normalized;
}

function normalizePossiblyStringifiedObject(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : value;
  } catch {
    return value;
  }
}
