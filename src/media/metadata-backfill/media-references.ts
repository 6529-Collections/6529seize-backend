import { publicMediaKey } from '@/drops/drop-media-purpose';

/** Public object prefixes that hold wave media: drop media and wave pictures. */
export const BACKFILL_KEY_PREFIXES = ['drops/', 'waves/'] as const;

/**
 * A `drops/` or `waves/` key written into free text: a CDN URL on any host
 * (copies and aliases of the URL exist), a JSON-escaped URL or a bare key.
 * The match stops at characters that usually delimit a URL, so a key with a
 * space or bracket in its file name yields a truncated prefix of itself;
 * {@link isReferencePrefixOf} still matches that key.
 */
const KEY_IN_TEXT =
  /(?:^|[^A-Za-z0-9_.-])((?:drops|waves)\/[^\s"'<>()[\]{}\\,|^`]+)/g;

/**
 * `<prefix>/<folder>/...`. A reference cut off right after the folder (a file
 * name starting with a space or bracket) still matches the whole folder:
 * over-excluding keeps original bytes, which is the safe side.
 */
const PREFIX_MATCHABLE_REFERENCE = /^(?:drops|waves)\/[^/]+\//;

export function isBackfillScopeKey(key: string): boolean {
  return BACKFILL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The object key a media URL serves, limited to wave media prefixes. */
export function backfillScopeKey(url: string): string | null {
  const key = publicMediaKey(url);
  return key && isBackfillScopeKey(key) ? key : null;
}

/** `drops/<folder>/`: the bucket a key and its truncated references share. */
export function keyFolder(key: string): string | null {
  const parts = key.split('/');
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}/` : null;
}

/**
 * True when a reference found in text names this key, possibly truncated at
 * a delimiter inside its file name. A reference without its folder's slash
 * only matches exactly.
 */
export function isReferencePrefixOf(reference: string, key: string): boolean {
  if (reference === key) return true;
  return (
    PREFIX_MATCHABLE_REFERENCE.test(reference) && key.startsWith(reference)
  );
}

function trimReference(raw: string): string {
  return raw.split(/[?#]/, 1)[0].replace(/[.;:!]+$/, '');
}

/**
 * Every wave media key a text mentions, in both its written and its
 * percent-decoded form, so comparison with decoded object keys cannot miss an
 * encoded variant.
 */
export function extractMediaKeyReferences(text: string): string[] {
  if (!text) return [];
  const references = new Set<string>();
  const unescaped = text.split('\\/').join('/');
  const pattern = new RegExp(KEY_IN_TEXT.source, 'g');
  for (
    let match = pattern.exec(unescaped);
    match !== null;
    match = pattern.exec(unescaped)
  ) {
    const written = trimReference(match[1]);
    if (!written) continue;
    references.add(written);
    try {
      references.add(decodeURIComponent(written));
    } catch {
      // A malformed escape; the written form is still recorded.
    }
  }
  return Array.from(references);
}

/** A JSON column may arrive as a string or as an already parsed value. */
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * CloudFront paths to invalidate for one object: the canonical per-segment
 * encoding of the key plus the exact paths clients were given.
 */
export function invalidationPathsFor(
  key: string,
  urls: readonly string[]
): string[] {
  const paths = new Set<string>([
    `/${key.split('/').map(encodeURIComponent).join('/')}`
  ]);
  for (const url of urls) {
    try {
      const { pathname } = new URL(url);
      if (pathname.length > 1) paths.add(pathname);
    } catch {
      // Not a URL; the canonical path above still covers the object.
    }
  }
  return Array.from(paths);
}
