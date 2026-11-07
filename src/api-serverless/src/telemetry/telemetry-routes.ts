import {
  TELEMETRY_API_ROUTE_ROOTS,
  TELEMETRY_ENTRY_ROUTE,
  TELEMETRY_EXTRA_PAGE_GROUPS,
  TELEMETRY_MAX_REFERRER_LENGTH,
  TELEMETRY_MAX_ROUTE_LENGTH,
  TELEMETRY_MAX_ROUTE_SEGMENTS,
  TELEMETRY_OTHER_PAGE_GROUP,
  TELEMETRY_OTHER_ROUTE,
  TELEMETRY_PAGE_ROUTE_ROOTS
} from '@/api/telemetry/telemetry.schema';

const STATIC_SEGMENT_SOURCE = '[a-z0-9][a-z0-9_-]{0,39}';
const PLACEHOLDER_SEGMENT_SOURCE =
  '\\[(?:\\.\\.\\.)?[A-Za-z]\\w{0,23}\\]|\\[\\[\\.\\.\\.[A-Za-z]\\w{0,23}\\]\\]|:[A-Za-z]\\w{0,23}';
const STATIC_SEGMENT = new RegExp(`^${STATIC_SEGMENT_SOURCE}$`);
const PLACEHOLDER_SEGMENT = new RegExp(`^(?:${PLACEHOLDER_SEGMENT_SOURCE})$`);
const SEGMENT_SOURCE = `(?:${STATIC_SEGMENT_SOURCE}|${PLACEHOLDER_SEGMENT_SOURCE})`;

/** Shape of a route template, published in the JSON Schema for clients. */
export const ROUTE_TEMPLATE_PATTERN_SOURCE = `^/(?:${SEGMENT_SOURCE}(?:/${SEGMENT_SOURCE}){0,7})?$`;
/** Shape of a referrer hostname, published in the JSON Schema for clients. */
export const HOSTNAME_PATTERN_SOURCE =
  '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$';
// Segments that look like identifiers are never kept as static text.
const ID_LIKE_SEGMENTS = [
  /^0x/,
  /^\d+$/,
  /\d{6,}/,
  /^[0-9a-f]{16,}$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}/
];
const PAGE_GROUP_PATTERN = /^[a-z0-9_-]{1,32}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OWN_HOSTS = ['6529.io'];

function isPlaceholder(segment: string): boolean {
  return PLACEHOLDER_SEGMENT.test(segment);
}

function isStaticSegment(segment: string): boolean {
  return (
    STATIC_SEGMENT.test(segment) &&
    !ID_LIKE_SEGMENTS.some((pattern) => pattern.test(segment))
  );
}

function splitTemplate(value: string): string[] | null {
  if (value === '/') {
    return [];
  }
  if (
    !value.startsWith('/') ||
    value.endsWith('/') ||
    value.length > TELEMETRY_MAX_ROUTE_LENGTH
  ) {
    return null;
  }
  const segments = value.slice(1).split('/');
  return segments.length <= TELEMETRY_MAX_ROUTE_SEGMENTS ? segments : null;
}

function isTemplateWithRoots(
  segments: readonly string[],
  roots: ReadonlySet<string>
): boolean {
  return segments.every((segment, index) => {
    if (isPlaceholder(segment)) {
      return true;
    }
    if (!isStaticSegment(segment)) {
      return false;
    }
    return index > 0 || roots.has(segment);
  });
}

function sanitizeTemplate(
  value: unknown,
  roots: ReadonlySet<string>
): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const segments = splitTemplate(value);
  if (segments === null || !isTemplateWithRoots(segments, roots)) {
    return TELEMETRY_OTHER_ROUTE;
  }
  return value;
}

/**
 * Returns the page route template, `/[other]` for anything that is not a
 * safe template of a known route, or null when no string was sent.
 */
export function sanitizePageRoute(value: unknown): string | null {
  return sanitizeTemplate(value, TELEMETRY_PAGE_ROUTE_ROOTS);
}

/** Like sanitizePageRoute, but also accepts the `entry` marker. */
export function sanitizePrevRoute(value: unknown): string | null {
  if (value === TELEMETRY_ENTRY_ROUTE) {
    return TELEMETRY_ENTRY_ROUTE;
  }
  return sanitizePageRoute(value);
}

/**
 * API endpoint templates (health counters) follow the route rules against
 * the API's own first segments. A leading `/api` is accepted and removed.
 */
export function sanitizeEndpointTemplate(value: string): string {
  const withoutPrefix =
    value === '/api' || value.startsWith('/api/') ? value.slice(4) : value;
  return (
    sanitizeTemplate(withoutPrefix || '/', TELEMETRY_API_ROUTE_ROOTS) ??
    TELEMETRY_OTHER_ROUTE
  );
}

export function sanitizePageGroup(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (
    PAGE_GROUP_PATTERN.test(value) &&
    (TELEMETRY_PAGE_ROUTE_ROOTS.has(value) ||
      TELEMETRY_EXTRA_PAGE_GROUPS.has(value))
  ) {
    return value;
  }
  return TELEMETRY_OTHER_PAGE_GROUP;
}

function isOwnHost(host: string): boolean {
  return OWN_HOSTS.some((own) => host === own || host.endsWith(`.${own}`));
}

/**
 * Referrer hostname only: lowercase, `www.` removed, at least two labels,
 * no IP literals, ports or paths, and never one of our own hosts.
 * Returns '' when the value is not a usable external hostname.
 */
export function sanitizeReferrerDomain(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (host.length === 0 || host.length > TELEMETRY_MAX_REFERRER_LENGTH) {
    return '';
  }
  const labels = host.split('.');
  if (
    labels.length < 2 ||
    !labels.every((label) => HOST_LABEL.test(label)) ||
    labels.every((label) => /^\d+$/.test(label)) ||
    isOwnHost(host)
  ) {
    return '';
  }
  return host;
}
