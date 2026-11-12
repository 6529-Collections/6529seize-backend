const PRODUCTION_WEB_APP_ORIGIN = 'https://6529.io';
const STAGING_WEB_APP_ORIGIN = 'https://staging.6529.io';

const LOCAL_WEB_APP_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001'
];

const DEFAULT_WEB_APP_ORIGINS_BY_API_HOST = new Map<string, string[]>([
  ['api.6529.io', [PRODUCTION_WEB_APP_ORIGIN]],
  ['api.staging.6529.io', [STAGING_WEB_APP_ORIGIN]]
]);

export function normalizeWebAppOrigin(
  value: string | null | undefined
): string | null {
  if (!value) {
    return null;
  }
  const rawOrigin = value.trim();
  if (
    !rawOrigin ||
    rawOrigin.toLowerCase() === 'null' ||
    rawOrigin.includes('\\')
  ) {
    return null;
  }
  try {
    const parsed = new URL(rawOrigin);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !hasOnlyOptionalRootPath(rawOrigin)
    ) {
      return null;
    }
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

function hasOnlyOptionalRootPath(value: string): boolean {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 1) {
    return false;
  }
  const authorityEnd = value.slice(schemeEnd + 3).search(/[/?#]/);
  if (authorityEnd < 0) {
    return true;
  }
  return value.slice(schemeEnd + 3 + authorityEnd) === '/';
}

export function getAllowedWebAuthCredentialOrigins(
  apiHostHeader: unknown
): string[] {
  return uniqueStrings([
    ...getDefaultWebAppOriginsForApiHost(apiHostHeader),
    ...getConfiguredWebAppOrigins(),
    ...getDeprecatedWebAuthCredentialOrigins()
  ]);
}

export function getWebAppSignatureDomains(): string[] {
  return uniqueStrings(
    [
      ...getDefaultWebAppOrigins(),
      ...getConfiguredWebAppOrigins(),
      ...getDeprecatedWebAuthCredentialOrigins()
    ]
      .map(getOriginHost)
      .filter((domain): domain is string => domain !== null)
  );
}

/**
 * Hosts of the first-party web origins of one API host: its built-in default
 * origin plus the configured ones, the same origins credentialed web sign-in
 * accepts there. The production API therefore leaves out the staging web
 * host, and the staging API the production one.
 */
export function getWebAppSignatureDomainsForApiHost(
  apiHostHeader: unknown
): string[] {
  return uniqueStrings(
    getAllowedWebAuthCredentialOrigins(apiHostHeader)
      .map(getOriginHost)
      .filter((domain): domain is string => domain !== null)
  );
}

function getDefaultWebAppOrigins(): string[] {
  return [PRODUCTION_WEB_APP_ORIGIN, STAGING_WEB_APP_ORIGIN];
}

function getDefaultWebAppOriginsForApiHost(apiHostHeader: unknown): string[] {
  const apiHost = parseApiHost(apiHostHeader);
  if (!apiHost) {
    return [];
  }
  if (apiHost.hostname === 'localhost' || apiHost.hostname === '127.0.0.1') {
    return LOCAL_WEB_APP_ORIGINS;
  }
  return DEFAULT_WEB_APP_ORIGINS_BY_API_HOST.get(apiHost.hostname) ?? [];
}

function getConfiguredWebAppOrigins(): string[] {
  return uniqueStrings([
    ...readSingleOriginEnv('WEB_APP_ORIGIN'),
    ...readOriginListEnv('WEB_APP_ADDITIONAL_ORIGINS')
  ]);
}

function getDeprecatedWebAuthCredentialOrigins(): string[] {
  return readOriginListEnv('AUTH_WEB_CREDENTIAL_ORIGINS');
}

function readSingleOriginEnv(envName: string): string[] {
  const origin = normalizeWebAppOrigin(process.env[envName]);
  return origin ? [origin] : [];
}

function readOriginListEnv(envName: string): string[] {
  return (
    process.env[envName]
      ?.split(',')
      .map(normalizeWebAppOrigin)
      .filter((origin): origin is string => origin !== null) ?? []
  );
}

function parseApiHost(apiHostHeader: unknown): URL | null {
  if (typeof apiHostHeader !== 'string') {
    return null;
  }
  const rawHost = apiHostHeader.trim().toLowerCase();
  if (!rawHost) {
    return null;
  }
  try {
    return new URL(rawHost.includes('://') ? rawHost : `https://${rawHost}`);
  } catch {
    return null;
  }
}

function getOriginHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

const MAX_RECORDED_ORIGIN_LENGTH = 255;
// scheme://authority with no credentials, path, query, fragment or backslash.
const SCHEME_AUTHORITY_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#\\@]+$/;

/**
 * A request Origin header as evidence to store: a normalized http(s) origin,
 * another scheme's origin (such as an app web view's) lowercased, "null" for
 * an opaque origin, or null when the header is missing or not an origin.
 */
export function toRecordedRequestOrigin(value: unknown): string | null {
  const raw = Array.isArray(value)
    ? value.find((it) => typeof it === 'string' && it.trim().length > 0)
    : value;
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'null') {
    return 'null';
  }
  const origin =
    normalizeWebAppOrigin(trimmed) ??
    (SCHEME_AUTHORITY_ORIGIN.test(trimmed) ? trimmed : null);
  return origin && origin.length <= MAX_RECORDED_ORIGIN_LENGTH ? origin : null;
}
