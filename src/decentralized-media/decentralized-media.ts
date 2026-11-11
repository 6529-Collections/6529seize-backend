import { Logger } from '@/logging';

export const DEFAULT_MEDIA_RESOLVER_ORIGIN = 'https://media.6529.io';

/**
 * User-provided media can be served from a separate content domain: a path
 * gateway (`media.<domain>`) and one host per CIDv1 (`<cid>.ipfs.<domain>`).
 * URLs on both domains are always understood as input. Which path gateway
 * the backend builds URLs on is selected by `MEDIA_RESOLVER_ENDPOINT`.
 */
const USER_CONTENT_DOMAIN = '6529usercontent.com';
const USER_CONTENT_MEDIA_HOST = `media.${USER_CONTENT_DOMAIN}`;
export const USER_CONTENT_MEDIA_RESOLVER_ORIGIN = `https://${USER_CONTENT_MEDIA_HOST}`;
const USER_CONTENT_IPFS_HOST_SUFFIX = `.ipfs.${USER_CONTENT_DOMAIN}`;
// Lowercase base32 CIDv1, exactly one DNS label.
const USER_CONTENT_IPFS_LABEL_PATTERN = /^b[a-z2-7]{50,61}$/;

export const MEDIA_RESOLVER_ENDPOINT_ENV = 'MEDIA_RESOLVER_ENDPOINT';

const CONFIGURABLE_MEDIA_RESOLVER_ORIGINS: readonly string[] = [
  DEFAULT_MEDIA_RESOLVER_ORIGIN,
  USER_CONTENT_MEDIA_RESOLVER_ORIGIN
];

const logger = Logger.get('DECENTRALIZED_MEDIA');
let lastUnsupportedEndpointLogged: string | null = null;

export type DecentralizedMediaProtocol = 'ipfs' | 'ipns' | 'arweave';

export type DecentralizedMediaRef = {
  readonly protocol: DecentralizedMediaProtocol;
  readonly id: string;
  readonly path: string;
};

export type DecentralizedMediaResolution = {
  readonly input: string;
  readonly recognized: boolean;
  readonly protocol?: DecentralizedMediaProtocol;
  readonly native_uri?: string;
  readonly id?: string;
  readonly path?: string;
  readonly resolver_url?: string;
  readonly external_fallback_urls: string[];
  readonly warnings: string[];
};

export type ResolveDecentralizedMediaOptions = {
  readonly includeExternalFallbacks?: boolean;
  readonly resolverOrigin?: string;
};

const MEDIA_RESOLVER_HOST = 'media.6529.io';

// The older 6529.io name of the path gateway. It stays an input alias and an
// external fallback while the 6529.io path gateway is the configured one.
const LEGACY_FIRST_PARTY_IPFS_PATH_GATEWAY = 'ipfs.6529.io';

const IPFS_PATH_GATEWAYS = [
  'ipfs.io',
  'cf-ipfs.com',
  'cloudflare-ipfs.com',
  'gateway.pinata.cloud',
  LEGACY_FIRST_PARTY_IPFS_PATH_GATEWAY
] as const;

const IPFS_SUBDOMAIN_GATEWAY_SUFFIXES = [
  '.ipfs.nftstorage.link',
  '.ipfs.dweb.link',
  '.ipfs.cf-ipfs.com'
] as const;

const ARWEAVE_GATEWAYS = [
  'arweave.net',
  'gateway.arweave.net',
  'gateway.ar.io',
  'ar-io.net',
  'ardrive.net'
] as const;

const ARWEAVE_TX_SUBDOMAIN_SUFFIXES = ['.arweave.net', '.ar.io'] as const;

const IPFS_PATH_GATEWAY_SET = new Set<string>(IPFS_PATH_GATEWAYS);
const ARWEAVE_GATEWAY_SET = new Set<string>(ARWEAVE_GATEWAYS);
const ARWEAVE_TX_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DNS_SAFE_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type ParsedDecentralizedMedia = {
  readonly ref: DecentralizedMediaRef;
  readonly warnings: string[];
};

export function parseDecentralizedMediaRef(
  input: string | null | undefined
): DecentralizedMediaRef | null {
  return parseDecentralizedMedia(input)?.ref ?? null;
}

export function toNativeUri(ref: DecentralizedMediaRef): string {
  const protocol = ref.protocol === 'arweave' ? 'ar' : ref.protocol;
  return `${protocol}://${buildPath(ref.id, ref.path)}`;
}

/**
 * Origin of the 6529 path gateway that resolver URLs are built on:
 * `MEDIA_RESOLVER_ENDPOINT` when it names one of the 6529 path gateways,
 * otherwise `https://media.6529.io`. Read on every call, because Lambda
 * configuration is loaded after modules are imported.
 */
export function getMediaResolverOrigin(): string {
  const configured = process.env[MEDIA_RESOLVER_ENDPOINT_ENV]?.trim();
  if (!configured) return DEFAULT_MEDIA_RESOLVER_ORIGIN;

  const origin = toConfigurableOrigin(configured);
  if (origin) return origin;

  if (lastUnsupportedEndpointLogged !== configured) {
    lastUnsupportedEndpointLogged = configured;
    logger.warn(
      `[MEDIA_RESOLVER_ENDPOINT_UNSUPPORTED] ${JSON.stringify({
        fallback: DEFAULT_MEDIA_RESOLVER_ORIGIN
      })}`
    );
  }
  return DEFAULT_MEDIA_RESOLVER_ORIGIN;
}

function toConfigurableOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return CONFIGURABLE_MEDIA_RESOLVER_ORIGINS.includes(url.origin) &&
      url.username === '' &&
      url.password === ''
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function isUserContentResolverOrigin(resolverOrigin: string): boolean {
  return normalizeOrigin(resolverOrigin) === USER_CONTENT_MEDIA_RESOLVER_ORIGIN;
}

export function to6529ResolverUrl(
  ref: DecentralizedMediaRef,
  resolverOrigin = getMediaResolverOrigin()
): string {
  const prefix = ref.protocol === 'arweave' ? 'arweave' : ref.protocol;
  return `${normalizeOrigin(resolverOrigin)}/${prefix}/${buildPath(
    ref.id,
    ref.path
  )}`;
}

export function toExternalFallbackUrls(
  ref: DecentralizedMediaRef,
  resolverOrigin = getMediaResolverOrigin()
): string[] {
  if (ref.protocol === 'arweave') {
    return [
      ...ARWEAVE_GATEWAYS.map(
        (host) => `https://${host}/${buildPath(ref.id, ref.path)}`
      ),
      ...(isDnsSafeSubdomainId(ref.id)
        ? ARWEAVE_TX_SUBDOMAIN_SUFFIXES.map((suffix) =>
            buildSubdomainUrl(ref.id, suffix.slice(1), ref.path)
          )
        : [])
    ];
  }

  const pathPrefix = ref.protocol === 'ipns' ? 'ipns' : 'ipfs';
  // With the separate content domain configured, the 6529.io path gateway is
  // no longer offered as a fallback; its URLs are still understood as input.
  const pathGateways = isUserContentResolverOrigin(resolverOrigin)
    ? IPFS_PATH_GATEWAYS.filter(
        (host) => host !== LEGACY_FIRST_PARTY_IPFS_PATH_GATEWAY
      )
    : IPFS_PATH_GATEWAYS;
  const pathGatewayUrls = pathGateways.map(
    (host) => `https://${host}/${pathPrefix}/${buildPath(ref.id, ref.path)}`
  );

  if (ref.protocol === 'ipns') {
    return pathGatewayUrls;
  }

  return [
    ...pathGatewayUrls,
    ...(isDnsSafeSubdomainId(ref.id)
      ? IPFS_SUBDOMAIN_GATEWAY_SUFFIXES.map((suffix) =>
          buildSubdomainUrl(ref.id, suffix.slice(1), ref.path)
        )
      : [])
  ];
}

export function resolveDecentralizedMediaInputs(
  inputs: readonly string[],
  options: ResolveDecentralizedMediaOptions = {}
): DecentralizedMediaResolution[] {
  return inputs.map((input) => resolveDecentralizedMediaInput(input, options));
}

export function normalizeDecentralizedMediaUri(
  input: string | null | undefined,
  resolverOrigin = getMediaResolverOrigin()
): string | undefined {
  if (input == null) return undefined;
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  const parsed = parseDecentralizedMediaRef(trimmed);
  return parsed ? to6529ResolverUrl(parsed, resolverOrigin) : trimmed;
}

export function getDecentralizedMediaFetchUrls(
  input: string,
  options: ResolveDecentralizedMediaOptions = {}
): string[] {
  const parsed = parseDecentralizedMediaRef(input);
  if (!parsed) return [input];

  const resolverOrigin = options.resolverOrigin ?? getMediaResolverOrigin();
  return [
    to6529ResolverUrl(parsed, resolverOrigin),
    ...(options.includeExternalFallbacks === false
      ? []
      : toExternalFallbackUrls(parsed, resolverOrigin))
  ];
}

/**
 * Whether `value` is a URL on a 6529 media gateway: the 6529.io path gateway
 * (by host name, as before), or, over https without userinfo or port, the
 * content-domain path gateway or one of its per-CID hosts.
 */
export function isFirstPartyMediaGatewayUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.hostname === MEDIA_RESOLVER_HOST) return true;
  const hostname = normalizeHostname(url.hostname);
  return (
    isStrictHttpsUrl(url) &&
    (hostname === USER_CONTENT_MEDIA_HOST ||
      looksLikeIpfsCid(getUserContentIpfsLabel(hostname) ?? ''))
  );
}

function resolveDecentralizedMediaInput(
  input: string,
  options: ResolveDecentralizedMediaOptions
): DecentralizedMediaResolution {
  const parsed = parseDecentralizedMedia(input);
  if (!parsed) {
    return {
      input,
      recognized: false,
      external_fallback_urls: [],
      warnings: getUnrecognizedWarnings(input)
    };
  }

  const resolverOrigin = options.resolverOrigin ?? getMediaResolverOrigin();
  return {
    input,
    recognized: true,
    protocol: parsed.ref.protocol,
    native_uri: toNativeUri(parsed.ref),
    id: parsed.ref.id,
    path: parsed.ref.path,
    resolver_url: to6529ResolverUrl(parsed.ref, resolverOrigin),
    external_fallback_urls:
      options.includeExternalFallbacks === false
        ? []
        : toExternalFallbackUrls(parsed.ref, resolverOrigin),
    warnings: parsed.warnings
  };
}

function parseDecentralizedMedia(
  input: string | null | undefined
): ParsedDecentralizedMedia | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const native = parseNativeUri(trimmed);
  if (native) return native;

  const url = parseHttpUrl(trimmed);
  if (!url) {
    return looksLikeIpfsCid(trimmed)
      ? { ref: { protocol: 'ipfs', id: trimmed, path: '' }, warnings: [] }
      : null;
  }

  return (
    parse6529ResolverUrl(url) ??
    parseIpfsPathGatewayUrl(url) ??
    parseUserContentIpfsHostUrl(url) ??
    parseIpfsSubdomainGatewayUrl(url) ??
    parseArweaveGatewayUrl(url) ??
    parseArweaveTxSubdomainUrl(url)
  );
}

function parseNativeUri(input: string): ParsedDecentralizedMedia | null {
  const protocolMatch = /^(ipfs|ipns|ar):\/\/(.+)$/i.exec(input);
  if (!protocolMatch?.[1] || !protocolMatch[2]) return null;

  const protocol =
    protocolMatch[1].toLowerCase() === 'ar'
      ? 'arweave'
      : (protocolMatch[1].toLowerCase() as DecentralizedMediaProtocol);
  const { value, warnings } = stripQueryAndHash(protocolMatch[2]);
  const parts = splitPath(value);
  const maybeId = parts[0] ?? '';

  if (
    protocol === 'ipfs' &&
    maybeId.toLowerCase() === 'ipfs' &&
    parts.length > 1
  ) {
    return makeParsed(protocol, parts[1] ?? '', parts.slice(2), warnings);
  }

  if (
    protocol === 'ipns' &&
    maybeId.toLowerCase() === 'ipns' &&
    parts.length > 1
  ) {
    return makeParsed(protocol, parts[1] ?? '', parts.slice(2), warnings);
  }

  return makeParsed(protocol, maybeId, parts.slice(1), warnings);
}

function is6529ResolverHost(url: URL): boolean {
  const hostname = normalizeHostname(url.hostname);
  if (hostname === MEDIA_RESOLVER_HOST) return true;
  return hostname === USER_CONTENT_MEDIA_HOST && isStrictHttpsUrl(url);
}

function parse6529ResolverUrl(url: URL): ParsedDecentralizedMedia | null {
  if (!is6529ResolverHost(url)) return null;

  const parts = splitPath(url.pathname);
  const prefix = (parts[0] ?? '').toLowerCase();
  if (prefix !== 'ipfs' && prefix !== 'ipns' && prefix !== 'arweave') {
    return null;
  }

  const protocol = prefix === 'arweave' ? 'arweave' : prefix;
  return makeParsed(
    protocol,
    parts[1] ?? '',
    parts.slice(2),
    getUrlWarnings(url)
  );
}

function parseIpfsPathGatewayUrl(url: URL): ParsedDecentralizedMedia | null {
  if (!IPFS_PATH_GATEWAY_SET.has(normalizeHostname(url.hostname))) return null;

  const parts = splitPath(url.pathname);
  const prefix = (parts[0] ?? '').toLowerCase();
  if (prefix !== 'ipfs' && prefix !== 'ipns') return null;

  return makeParsed(
    prefix,
    parts[1] ?? '',
    parts.slice(2),
    getUrlWarnings(url)
  );
}

/**
 * Per-CID host of the content domain: `https://<cidv1>.ipfs.<domain>/<path>`
 * is the same content as `/ipfs/<cidv1>/<path>` on the path gateway. Such a
 * host also serves `/ipfs/<other cid>/<path>` from that other CID, so that
 * form parses to the other CID.
 */
function parseUserContentIpfsHostUrl(
  url: URL
): ParsedDecentralizedMedia | null {
  if (!isStrictHttpsUrl(url)) return null;
  const label = getUserContentIpfsLabel(normalizeHostname(url.hostname));
  if (label === null) return null;

  const parts = splitPath(url.pathname);
  const nestedCid =
    parts[0] === 'ipfs' && parts[1] && looksLikeIpfsCid(parts[1])
      ? parts[1]
      : null;
  return nestedCid
    ? makeParsed('ipfs', nestedCid, parts.slice(2), getUrlWarnings(url))
    : makeParsed('ipfs', label, parts, getUrlWarnings(url));
}

function getUserContentIpfsLabel(hostname: string): string | null {
  if (!hostname.endsWith(USER_CONTENT_IPFS_HOST_SUFFIX)) return null;
  const label = hostname.slice(0, -USER_CONTENT_IPFS_HOST_SUFFIX.length);
  return USER_CONTENT_IPFS_LABEL_PATTERN.test(label) ? label : null;
}

function isStrictHttpsUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

function parseIpfsSubdomainGatewayUrl(
  url: URL
): ParsedDecentralizedMedia | null {
  const hostname = normalizeHostname(url.hostname);
  const suffix = IPFS_SUBDOMAIN_GATEWAY_SUFFIXES.find((candidate) =>
    hostname.endsWith(candidate)
  );
  if (!suffix) return null;

  const cid = hostname.slice(0, -suffix.length);
  return makeParsed('ipfs', cid, splitPath(url.pathname), getUrlWarnings(url));
}

function parseArweaveGatewayUrl(url: URL): ParsedDecentralizedMedia | null {
  if (!ARWEAVE_GATEWAY_SET.has(normalizeHostname(url.hostname))) return null;

  const parts = splitPath(url.pathname);
  return makeParsed(
    'arweave',
    parts[0] ?? '',
    parts.slice(1),
    getUrlWarnings(url)
  );
}

function parseArweaveTxSubdomainUrl(url: URL): ParsedDecentralizedMedia | null {
  const hostname = normalizeHostname(url.hostname);
  const suffix = ARWEAVE_TX_SUBDOMAIN_SUFFIXES.find((candidate) =>
    hostname.endsWith(candidate)
  );
  if (!suffix) return null;

  const txid = hostname.slice(0, -suffix.length);
  const pathParts = splitPath(url.pathname);
  const normalizedPathParts =
    pathParts[0] === txid ? pathParts.slice(1) : pathParts;
  return makeParsed('arweave', txid, normalizedPathParts, getUrlWarnings(url));
}

function makeParsed(
  protocol: DecentralizedMediaProtocol,
  id: string,
  pathParts: readonly string[],
  warnings: readonly string[]
): ParsedDecentralizedMedia | null {
  const normalizedId = id.trim();
  if (!isValidIdSegment(normalizedId)) return null;
  if (!isValidProtocolId(protocol, normalizedId)) return null;

  return {
    ref: {
      protocol,
      id: normalizedId,
      path: normalizePath(pathParts)
    },
    warnings: [...warnings]
  };
}

function splitPath(path: string): string[] {
  return path
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalizePath(pathParts: readonly string[]): string {
  return pathParts.map(encodePathSegment).join('/');
}

function buildPath(id: string, path: string): string {
  const normalizedPath = splitPath(path).map(encodePathSegment).join('/');
  if (!normalizedPath) return encodePathSegment(id);
  return `${encodePathSegment(id)}/${normalizedPath}`;
}

function buildSubdomainUrl(
  id: string,
  hostSuffix: string,
  path: string
): string {
  const normalizedPath = splitPath(path).map(encodePathSegment).join('/');
  return normalizedPath
    ? `https://${encodePathSegment(id)}.${hostSuffix}/${normalizedPath}`
    : `https://${encodePathSegment(id)}.${hostSuffix}`;
}

function normalizeOrigin(origin: string): string {
  let end = origin.length;
  while (end > 0 && origin.codePointAt(end - 1) === 47) {
    end -= 1;
  }

  return origin.slice(0, end);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function parseHttpUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function stripQueryAndHash(value: string): {
  readonly value: string;
  readonly warnings: string[];
} {
  const index = findFirstIndex(value, ['?', '#']);
  if (index < 0) return { value, warnings: [] };
  return {
    value: value.slice(0, index),
    warnings: ['query_or_hash_stripped']
  };
}

function getUrlWarnings(url: URL): string[] {
  return url.search || url.hash ? ['query_or_hash_stripped'] : [];
}

function getUnrecognizedWarnings(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed === '') return ['invalid_url'];
  if (/^https?:\/\//i.exec(trimmed)) {
    return parseHttpUrl(trimmed) ? [] : ['invalid_url'];
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (schemeMatch?.[1]) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'ipfs' || scheme === 'ipns' || scheme === 'ar') {
      return ['invalid_url'];
    }
    return ['unsupported_scheme'];
  }
  if (trimmed.includes('://')) return ['invalid_url'];
  return [];
}

function findFirstIndex(value: string, needles: readonly string[]): number {
  const indexes = needles
    .map((needle) => value.indexOf(needle))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  return indexes[0] ?? -1;
}

function encodePathSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

function isValidIdSegment(value: string): boolean {
  return value.length > 0 && !/[\s/?#]/.exec(value);
}

function isValidProtocolId(
  protocol: DecentralizedMediaProtocol,
  value: string
): boolean {
  if (protocol === 'ipfs') return looksLikeIpfsCid(value);
  if (protocol === 'arweave') return looksLikeArweaveTxId(value);
  return true;
}

function looksLikeIpfsCid(value: string): boolean {
  // Deliberately limited to DNS-safe gateway forms covered by tests: CIDv0
  // and base32 bafy CIDv1. Other valid CIDv1 prefixes are outside this helper.
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|[bB][aA][fF][a-zA-Z2-7]{20,})$/.test(
    value
  );
}

function looksLikeArweaveTxId(value: string): boolean {
  return ARWEAVE_TX_ID_PATTERN.test(value);
}

function isDnsSafeSubdomainId(value: string): boolean {
  return DNS_SAFE_LABEL_PATTERN.test(value);
}
