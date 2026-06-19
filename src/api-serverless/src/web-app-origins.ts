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
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
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
