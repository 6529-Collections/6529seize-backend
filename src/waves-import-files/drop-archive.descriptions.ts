import { canonicalJson } from '@/waves-import-files/drop-archive.format';

/**
 * A wave's description drop, found in its drop archive from what the wave's
 * document (the Waves v1 file's wave row names it by CID) says of it:
 *
 * - the drop the document names by `description_drop_id`, when it does;
 * - else the one drop whose parts (content, and each medium's url and
 *   type) are the document's `description`. When no drop or several match,
 *   the wave is left without one and reported: two drops with the same
 *   text can't be told apart from what the chain commits.
 */

/** What a wave document says of its description drop. */
export interface WaveDescription {
  /** The drop's id when the document names it, else null. */
  readonly dropId: string | null;
  /** The description's parts as canonical JSON, to compare with a line's. */
  readonly parts: string;
}

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/**
 * Parts as the wave document writes them: each part's content, and each
 * medium's url and type. Null when they are not parts.
 */
export function descriptionParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const out: Json[] = [];
  for (const value of parts) {
    const part = object(value);
    if (!part || !Array.isArray(part.media)) return null;
    const media: Json[] = [];
    for (const medium of part.media) {
      const m = object(medium);
      if (!m) return null;
      media.push({ url: m.url ?? null, mime_type: m.mime_type ?? null });
    }
    out.push({ content: part.content ?? null, media });
  }
  return canonicalJson(out);
}

/** A wave document's description; throws when it is not a wave document. */
export function waveDescriptionOf(document: Uint8Array): WaveDescription {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(document).toString('utf8'));
  } catch {
    throw new Error('the wave document is not JSON');
  }
  const doc = object(json);
  if (!doc || doc.kind !== 'wave') {
    throw new Error('the document is not a wave document');
  }
  const parts = descriptionParts(doc.description);
  if (parts === null) {
    throw new Error('the wave document has no description');
  }
  const named = doc.description_drop_id;
  if (named !== undefined && named !== null && typeof named !== 'string') {
    throw new Error('the wave document names its description drop wrongly');
  }
  return { dropId: named ?? null, parts };
}

/** The description drop among an archive's lines, or why there is none. */
export function resolveDescription(
  description: WaveDescription,
  /** Ids of the drops whose parts match the description. */
  matching: readonly string[],
  /** Whether the archive holds the drop the document names. */
  holdsNamed: boolean
): { dropId: string } | { reason: string } {
  if (description.dropId !== null) {
    return holdsNamed
      ? { dropId: description.dropId }
      : { reason: 'its archive does not hold the drop its document names' };
  }
  if (matching.length === 1) return { dropId: matching[0] };
  return {
    reason: matching.length
      ? `${matching.length} drops match its description`
      : 'no drop matches its description'
  };
}
