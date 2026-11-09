import { publicMediaKey } from '@/drops/drop-media-purpose';

/** Public object prefixes that hold wave media: drop media and wave pictures. */
export const BACKFILL_KEY_PREFIXES = ['drops/', 'waves/'] as const;

/**
 * A `drops/` or `waves/` key written into free text: a CDN URL on any host
 * (copies and aliases of the URL exist), a JSON-escaped URL or a bare key.
 * A reference runs to the first character that usually delimits a URL, so a
 * key with a space or bracket in its file name yields a truncated prefix of
 * itself; {@link isReferencePrefixOf} still matches that key. The text is
 * user-authored, so it is scanned with `indexOf` in linear time, never with a
 * backtracking regular expression.
 */
/** Characters that end a reference, besides any whitespace. */
const REFERENCE_DELIMITERS: ReadonlySet<string> = new Set([
  '"',
  "'",
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  String.fromCharCode(92), // backslash
  ',',
  '|',
  '^',
  '`'
]);
const WHITESPACE = /\s/;
/** A reference must not continue a longer word, such as `raindrops/`. */
const WORD_CHARACTER = /[A-Za-z0-9_.-]/;
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set(['.', ';', ':', '!']);

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
  let end = raw.length;
  for (const terminator of ['?', '#']) {
    const at = raw.indexOf(terminator);
    if (at >= 0 && at < end) end = at;
  }
  while (end > 0 && TRAILING_PUNCTUATION.has(raw[end - 1])) end--;
  return raw.slice(0, end);
}

function isReferenceStart(text: string, at: number): boolean {
  return at === 0 || !WORD_CHARACTER.test(text[at - 1]);
}

function isDelimiter(character: string): boolean {
  return REFERENCE_DELIMITERS.has(character) || WHITESPACE.test(character);
}

function referenceEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && !isDelimiter(text[end])) end++;
  return end;
}

/**
 * Raw references after each `prefix` occurrence. Scanning resumes after each
 * reference, so every character is visited a bounded number of times.
 */
function rawReferences(text: string, prefix: string): string[] {
  const references: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(prefix, from);
    if (at < 0) return references;
    if (!isReferenceStart(text, at)) {
      from = at + 1;
      continue;
    }
    const end = referenceEnd(text, at + prefix.length);
    if (end > at + prefix.length) references.push(text.slice(at, end));
    from = end;
  }
}

/**
 * Every wave media key a text mentions, in both its written and its
 * percent-decoded form, so comparison with decoded object keys cannot miss an
 * encoded variant.
 */
export function extractMediaKeyReferences(text: string): string[] {
  if (!text) return [];
  const references = new Set<string>();
  const unescaped = text.split(String.raw`\/`).join('/');
  for (const prefix of BACKFILL_KEY_PREFIXES) {
    for (const raw of rawReferences(unescaped, prefix)) {
      const written = trimReference(raw);
      if (written.length <= prefix.length) continue;
      references.add(written);
      try {
        references.add(decodeURIComponent(written));
      } catch {
        // A malformed escape; the written form is still recorded.
      }
    }
  }
  return Array.from(references);
}

/** A JSON column may arrive as a string or as an already parsed value. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return typeof value === 'number' || typeof value === 'boolean'
    ? `${value}`
    : '';
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
