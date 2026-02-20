export interface OgData {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  lastPrice?: string;
}

const PREFERRED_IMAGE_KEYS_IN_ORDER = [
  'mediaUrl',
  'media_url',
  'mediaUri',
  'media_uri',
  'imageUrl',
  'image_url',
  'imageUri',
  'image_uri',
  'animationUrl',
  'animation_url',
  'animationUri',
  'animation_uri'
] as const;

const PREFERRED_IMAGE_REGEXES = PREFERRED_IMAGE_KEYS_IN_ORDER.map((key) =>
  createJsonStringFieldRegex(key)
);
const DISALLOWED_NAME_VALUES = new Set([
  'viewport',
  'description',
  'theme-color',
  'keywords',
  'author',
  'robots',
  'generator',
  'application-name',
  'apple-mobile-web-app-title',
  'next-size-adjust'
]);

function isMetaTagBoundary(ch: string | undefined): boolean {
  return (
    ch === undefined ||
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '/' ||
    ch === '>'
  );
}

function findTagEnd(html: string, from: number): number {
  let quote: '"' | "'" | null = null;

  for (let i = from; i < html.length; i++) {
    const ch = html[i];

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '>') {
      return i;
    }
  }

  return -1;
}

function collectMetaTags(html: string): string[] {
  const tags: string[] = [];
  const lower = html.toLowerCase();
  let cursor = 0;

  while (cursor < lower.length) {
    const start = lower.indexOf('<meta', cursor);
    if (start === -1) break;

    // Avoid matching prefixes like "<metadata...>".
    if (!isMetaTagBoundary(lower[start + 5])) {
      cursor = start + 5;
      continue;
    }

    const end = findTagEnd(html, start + 5);
    if (end === -1) break;

    tags.push(html.slice(start, end + 1));
    cursor = end + 1;
  }

  return tags;
}

function createJsonStringFieldRegex(fieldName: string, global = false): RegExp {
  return new RegExp(
    String.raw`\\?["']${fieldName}\\?["']\s*:\s*(\\?["'])([\s\S]*?)\1`,
    global ? 'ig' : 'i'
  );
}

function decodeJsonEscapedUrl(url: string): string {
  return url.replace(/\\\//g, '/');
}

function decodeJsonEscapedString(value: string): string {
  return value
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

function findFirstJsonStringFieldValue(
  html: string,
  fieldName: string,
  predicate?: (value: string) => boolean
): string | undefined {
  const regex = createJsonStringFieldRegex(fieldName, true);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html))) {
    if (!match[2]) continue;
    const value = decodeJsonEscapedString(match[2]).trim();
    if (!value) continue;
    if (!predicate || predicate(value)) {
      return value;
    }
  }

  return undefined;
}

function isLikelyAssetName(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  if (!normalized) return false;
  if (normalized.startsWith('next.')) return false;
  if (normalized.startsWith('twitter:') || normalized.startsWith('og:')) {
    return false;
  }

  return !DISALLOWED_NAME_VALUES.has(normalized);
}

// Very small, dependency-free OG parser.
// Assumes HTML is trusted enough for regex extraction (we only fetch allowlisted domains).
export function extractOg(html: string): OgData {
  const og: OgData = {};
  const propRegex = /(property|name)\s*=\s*"([^"]+)"/i;
  const contentRegex = /content\s*=\s*"([^"]*)"/i;
  const lastPriceRegex = /\\?["']lastPrice\\?["']\s*:\s*\\?["'](\d+)\\?["']/i;
  let ogTitle: string | undefined;
  let ogDescription: string | undefined;
  let ogImage: string | undefined;

  const tags = collectMetaTags(html);
  for (const tag of tags) {
    const propMatch = propRegex.exec(tag);
    const contentMatch = contentRegex.exec(tag);
    if (!propMatch || !contentMatch) continue;
    const key = propMatch[2].toLowerCase();
    const value = contentMatch[1];

    if (key === 'og:title') ogTitle = ogTitle ?? value;
    else if (key === 'og:description') ogDescription = ogDescription ?? value;
    else if (key === 'og:image') ogImage = ogImage ?? value;
    else if (key === 'og:site_name') og.siteName = og.siteName ?? value;
  }

  const jsonName = findFirstJsonStringFieldValue(
    html,
    'name',
    isLikelyAssetName
  );
  if (jsonName) {
    og.title = jsonName;
  } else if (ogTitle) {
    og.title = ogTitle;
  }

  const jsonDescription = findFirstJsonStringFieldValue(html, 'description');
  if (jsonDescription) {
    og.description = jsonDescription;
  } else if (ogDescription) {
    og.description = ogDescription;
  }

  for (const regex of PREFERRED_IMAGE_REGEXES) {
    const match = regex.exec(html);
    if (match?.[2]) {
      og.image = decodeJsonEscapedUrl(match[2]);
      break;
    }
  }

  if (!og.image && ogImage) {
    og.image = ogImage;
  }

  const lastPriceMatch = lastPriceRegex.exec(html);
  if (lastPriceMatch?.[1]) {
    og.lastPrice = lastPriceMatch[1];
  }

  return og;
}
