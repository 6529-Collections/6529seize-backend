import type { CanonicalIdentifiers, CanonicalLink, Platform } from './types';
import { NftLinkResolverValidationError } from '@/nft-links/nft-link-resolver-validation.error';
import { env } from '@/env';

// NOTE: This validation is intentionally NO-network. Verification is a separate step.

const HOST_ALLOWLIST = {
  SUPERRARE: new Set(['superrare.com']),
  OPENSEA: new Set(['opensea.io', 'testnets.opensea.io']),
  FOUNDATION: new Set(['foundation.app']),
  MANIFOLD: new Set([
    'app.manifold.xyz',
    'manifold.xyz',
    'studio.manifold.xyz',
    'help.manifold.xyz'
  ]),
  TRANSIENT: new Set(['transient.xyz', 'lab.transient.xyz'])
} as const;

const TRACKING_KEYS_PREFIXES = ['utm_'];
const TRACKING_KEYS_EXACT = new Set([
  'ref',
  'referrer',
  'source',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid'
]);

function cleanInputUrl(raw: string): string {
  let s = (raw ?? '').trim();
  s = s.replace(/^<(.+)>$/, '$1');
  s = s.replace(/^"(.+)"$/, '$1');
  s = s.replace(/^'(.+)'$/, '$1');
  return s.trim();
}

function safeParseUrl(raw: string): URL | null {
  const s = cleanInputUrl(raw);
  if (!s) return null;
  const maxLen = env.getIntOrNull('LINK_RESOLVER_MAX_URL_LENGTH') ?? 2048;
  if (Number.isFinite(maxLen) && maxLen > 0 && s.length > maxLen) return null;
  try {
    return new URL(s);
  } catch {
    try {
      return new URL(`https://${s}`);
    } catch {
      return null;
    }
  }
}

function stripWww(hostname: string): string {
  const h = (hostname ?? '').toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

function isHttps(u: URL): boolean {
  return u.protocol === 'https:';
}

function isTrackingKey(key: string): boolean {
  const k = key.toLowerCase();
  if (TRACKING_KEYS_EXACT.has(k)) return true;
  return TRACKING_KEYS_PREFIXES.some((p) => k.startsWith(p));
}

function trimTrailingSlashes(pathname: string): string {
  if (pathname.length <= 1) return pathname;
  let end = pathname.length;
  while (end > 1 && pathname.codePointAt(end - 1) === 47) end--;
  return end === pathname.length ? pathname : pathname.slice(0, end);
}

function normalizeUrlForView(u: URL): string {
  const v = new URL(u.toString());
  v.hostname = stripWww(v.hostname);

  for (const key of Array.from(v.searchParams.keys())) {
    if (isTrackingKey(key)) v.searchParams.delete(key);
  }

  if (v.pathname.length > 1 && v.pathname.endsWith('/')) {
    v.pathname = trimTrailingSlashes(v.pathname);
  }

  return v.toString();
}

function getEffectivePath(u: URL): string {
  // SPA hash routing support
  if (u.hash.startsWith('#/')) return u.hash.slice(1);
  return u.pathname;
}

function normalizeEvmAddress(addr: string): string | null {
  const a = addr.toLowerCase();
  if (!a.startsWith('0x')) return null;
  if (!/^0x[a-f0-9]{40}$/.test(a)) return null;
  return a;
}

function normalizeTokenId(tokenId: string): string | null {
  const t = tokenId.trim();
  if (!/^\d+$/.test(t)) return null;
  // keep "0" stable
  if (t === '0') return t;
  return t.replace(/^0+/, '') || '0';
}

function buildCanonicalId(
  platform: Platform,
  identifiers: CanonicalIdentifiers,
  viewUrl: string
): string {
  if (identifiers.kind === 'TOKEN') {
    return `${platform}:${identifiers.chain}:${identifiers.contract}:${identifiers.tokenId}`;
  }
  if (identifiers.kind === 'CONTRACT_ONLY') {
    return `${platform}:${identifiers.chain}:${identifiers.contract}`;
  }
  if (identifiers.kind === 'MANIFOLD_CLAIM') {
    if (identifiers.instanceId)
      return `${platform}:claim:${identifiers.instanceId}`;
    if (identifiers.instanceSlug)
      return `${platform}:slug:${identifiers.instanceSlug.toLowerCase()}`;
  }
  return `${platform}:url:${Buffer.from(viewUrl).toString('base64url')}`;
}

function enforceEthMainnet(
  chain: string,
  inputUrl: string,
  platform: string
): 'eth' {
  const c = String(chain ?? '').toLowerCase();
  if (c === 'eth') return 'eth';
  // Many URLs use "ethereum" in the path; accept but normalize.
  if (c === 'ethereum') return 'eth';
  throw new NftLinkResolverValidationError(
    `Invalid chain in link ${inputUrl}. ${platform} links are only supported on Ethereum mainnet in phase 1.`
  );
}

function ok(
  inputUrl: string,
  platform: Platform,
  viewUrl: string,
  identifiers: CanonicalIdentifiers
): CanonicalLink {
  const canonicalId = buildCanonicalId(platform, identifiers, viewUrl);
  return {
    platform,
    viewUrl,
    canonicalId,
    identifiers,
    originalUrl: inputUrl
  };
}

function parseSuperRare(u: URL, inputUrl: string): CanonicalLink {
  const viewUrl = normalizeUrlForView(u);
  const effectivePath = getEffectivePath(u);

  const m = /^\/artwork\/([a-z0-9-]+)\/(0x[a-fA-F0-9]{40})\/(\d+)\/?$/.exec(
    effectivePath
  );
  if (!m) {
    throw new NftLinkResolverValidationError(
      `SuperRare link must look like /artwork/{chain}/{contract}/{tokenId}.`
    );
  }

  const rawChain = m[1].toLowerCase();
  const chain = enforceEthMainnet(rawChain, inputUrl, 'SuperRare');
  const contract = normalizeEvmAddress(m[2]);
  const tokenId = normalizeTokenId(m[3]);

  if (!contract) {
    throw new NftLinkResolverValidationError(
      `Invalid contract address in SuperRare URL.`
    );
  }
  if (!tokenId) {
    throw new NftLinkResolverValidationError(
      `Invalid tokenId in SuperRare URL.`
    );
  }
  return ok(inputUrl, 'SUPERRARE', viewUrl, {
    kind: 'TOKEN',
    chain,
    contract,
    tokenId
  });
}

const OPENSEA_CHAIN_MAP: Record<string, string> = {
  ethereum: 'eth',
  eth: 'eth',
  mainnet: 'eth',
  // NOTE: In phase 1 we intentionally do not enable other chains.
  // Keep mappings here so expanding support is a small change.
  polygon: 'polygon',
  matic: 'polygon',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  sepolia: 'sepolia',
  goerli: 'goerli'
};

function normalizeOpenSeaChain(raw: string | undefined): string {
  if (!raw) return 'eth';
  const k = raw.toLowerCase();
  return OPENSEA_CHAIN_MAP[k] ?? k;
}

function parseOpenSea(u: URL, inputUrl: string): CanonicalLink {
  const viewUrl = normalizeUrlForView(u);
  const effectivePath = getEffectivePath(u);

  // /assets/{chain}/{contract}/{tokenId}
  let m = /^\/assets\/([a-z0-9-]+)\/(0x[a-fA-F0-9]{40})\/(\d+)\/?$/.exec(
    effectivePath
  );
  if (m) {
    const chain = enforceEthMainnet(
      normalizeOpenSeaChain(m[1]),
      inputUrl,
      'OpenSea'
    );
    const contract = normalizeEvmAddress(m[2]);
    const tokenId = normalizeTokenId(m[3]);
    if (!contract) {
      throw new NftLinkResolverValidationError(
        `Invalid contract address in OpenSea URL.`
      );
    }
    if (!tokenId) {
      throw new NftLinkResolverValidationError(
        `Invalid tokenId in OpenSea URL.`
      );
    }
    return ok(inputUrl, 'OPENSEA', viewUrl, {
      kind: 'TOKEN',
      chain,
      contract,
      tokenId
    });
  }

  // /item/{chain}/{contract}/{tokenId} (newer OpenSea URL format)
  m = /^\/item\/([a-z0-9-]+)\/(0x[a-fA-F0-9]{40})\/(\d+)\/?$/.exec(
    effectivePath
  );
  if (m) {
    const chain = enforceEthMainnet(
      normalizeOpenSeaChain(m[1]),
      inputUrl,
      'OpenSea'
    );
    const contract = normalizeEvmAddress(m[2]);
    const tokenId = normalizeTokenId(m[3]);
    if (!contract) {
      throw new NftLinkResolverValidationError(
        `Invalid contract address in OpenSea URL.`
      );
    }
    if (!tokenId) {
      throw new NftLinkResolverValidationError(
        `Invalid tokenId in OpenSea URL.`
      );
    }
    return ok(inputUrl, 'OPENSEA', viewUrl, {
      kind: 'TOKEN',
      chain,
      contract,
      tokenId
    });
  }

  // /assets/{contract}/{tokenId} => assume eth
  m = /^\/assets\/(0x[a-fA-F0-9]{40})\/(\d+)\/?$/.exec(effectivePath);
  if (m) {
    const chain = 'eth';
    const contract = normalizeEvmAddress(m[1]);
    const tokenId = normalizeTokenId(m[2]);
    if (!contract) {
      throw new NftLinkResolverValidationError(
        `Invalid contract address in OpenSea URL.`
      );
    }
    if (!tokenId) {
      throw new NftLinkResolverValidationError(
        `Invalid tokenId in OpenSea URL.`
      );
    }

    return ok(inputUrl, 'OPENSEA', viewUrl, {
      kind: 'TOKEN',
      chain,
      contract,
      tokenId
    });
  }
  throw new NftLinkResolverValidationError(
    `OpenSea link must look like /assets/{chain}/{contract}/{tokenId} or /item/{chain}/{contract}/{tokenId}.`
  );
}

function parseFoundation(u: URL, inputUrl: string): CanonicalLink {
  const viewUrl = normalizeUrlForView(u);
  const effectivePath = getEffectivePath(u);

  // /mint/{chain}/{contract}/{tokenId}
  let m = /^\/mint\/([a-z0-9-]+)\/(0x[a-fA-F0-9]{40})\/(\d+)\/?$/.exec(
    effectivePath
  );
  if (m) {
    const chain = enforceEthMainnet(m[1].toLowerCase(), inputUrl, 'Foundation');
    const contract = normalizeEvmAddress(m[2]);
    const tokenId = normalizeTokenId(m[3]);
    if (!contract) {
      throw new NftLinkResolverValidationError(
        `Invalid contract address in Foundation URL`
      );
    }
    if (!tokenId) {
      throw new NftLinkResolverValidationError(
        `Invalid tokenId in Foundation URL.`
      );
    }
    return ok(inputUrl, 'FOUNDATION', viewUrl, {
      kind: 'TOKEN',
      chain,
      contract,
      tokenId
    });
  }

  // /mint/{chain}/{contract} (contract-level mint URL; tokenId omitted)
  m = /^\/mint\/([a-z0-9-]+)\/(0x[a-fA-F0-9]{40})\/?$/.exec(effectivePath);
  if (m) {
    const chain = enforceEthMainnet(m[1].toLowerCase(), inputUrl, 'Foundation');
    const contract = normalizeEvmAddress(m[2]);
    if (!contract) {
      throw new NftLinkResolverValidationError(
        `Invalid contract address in Foundation URL.`
      );
    }
    return ok(inputUrl, 'FOUNDATION', viewUrl, {
      kind: 'CONTRACT_ONLY',
      chain,
      contract
    });
  }
  throw new NftLinkResolverValidationError(
    `Foundation link must look like /mint/{chain}/{contract}/{tokenId} (or /mint/{chain}/{contract} for contract-level mint pages).`
  );
}

const TRANSIENT_CHAIN_MAP: Record<string, string> = {
  ethereum: 'eth',
  eth: 'eth',
  mainnet: 'eth',
  arbitrum: 'arbitrum',
  arb: 'arbitrum',
  arbitrumone: 'arbitrum',
  base: 'base',
  optimism: 'optimism',
  op: 'optimism',
  polygon: 'polygon',
  matic: 'polygon'
};

function normalizeTransientChain(raw: string): string {
  const k = (raw ?? '').toLowerCase();
  return TRANSIENT_CHAIN_MAP[k] ?? k;
}

function parseTransient(u: URL, inputUrl: string): CanonicalLink {
  const viewUrl = normalizeUrlForView(u);
  const effectivePath = getEffectivePath(u);

  // Token pages: /nfts/{chain}/{contract}/{tokenId}
  let m = /^\/nfts\/([a-z0-9-]+)\/(0x[a-fA-F0-9]{40})\/(\d+)\/?$/.exec(
    effectivePath
  );
  if (m) {
    const chain = enforceEthMainnet(
      normalizeTransientChain(m[1]),
      inputUrl,
      'Transient'
    );
    const contract = normalizeEvmAddress(m[2]);
    const tokenId = normalizeTokenId(m[3]);
    if (!contract) {
      throw new NftLinkResolverValidationError(
        `Invalid contract address in Transient URL.`
      );
    }
    if (!tokenId) {
      throw new NftLinkResolverValidationError(
        `Invalid tokenId in Transient URL.`
      );
    }
    return ok(inputUrl, 'TRANSIENT', viewUrl, {
      kind: 'TOKEN',
      chain,
      contract,
      tokenId
    });
  }

  // Mint pages: /mint/{slug} (no onchain identifiers in URL)
  m = /^\/mint\/([^/?#]+)\/?$/.exec(effectivePath);
  if (m) {
    return ok(inputUrl, 'TRANSIENT', viewUrl, { kind: 'URL_ONLY' });
  }
  throw new NftLinkResolverValidationError(
    `Transient link must look like /nfts/{chain}/{contract}/{tokenId} or /mint/{slug}.`
  );
}

function extractManifoldIdentifiers(u: URL): {
  instanceId?: string;
  instanceSlug?: string;
} {
  const qpCandidates = [
    'id',
    'instanceId',
    'claimId',
    'claimID',
    'instance',
    'instance_id'
  ];
  for (const k of qpCandidates) {
    const v = u.searchParams.get(k);
    if (v && /^[a-zA-Z0-9_-]{3,128}$/.test(v)) return { instanceId: v };
  }

  const effectivePath = getEffectivePath(u);

  // Newer manifold.xyz URLs can look like:
  //   /@carity/id/4120783088
  // ...where the numeric ID corresponds to a claim instance ID.
  // We intentionally parse only a numeric id here to avoid false positives.
  let m = /^\/(?:@[^/]+|%40[^/]+)\/id\/(\d+)\/?$/.exec(effectivePath);
  if (m) {
    return { instanceId: decodeURIComponent(m[1]) };
  }

  // Also allow a generic /id/<digits> form if it exists.
  m = /^\/id\/(\d+)\/?$/.exec(effectivePath);
  if (m) {
    return { instanceId: decodeURIComponent(m[1]) };
  }

  m = /^\/c\/([^/?#]+)\/?$/.exec(effectivePath);
  if (m) {
    const slug = decodeURIComponent(m[1]).trim();
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,128}$/.test(slug))
      return { instanceSlug: slug };
  }

  m = /^\/claim\/([^/?#]+)\/?$/.exec(effectivePath);
  if (m) {
    const slug = decodeURIComponent(m[1]).trim();
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,128}$/.test(slug))
      return { instanceSlug: slug };
  }

  return {};
}

function parseManifold(u: URL, inputUrl: string): CanonicalLink {
  let viewUrl = normalizeUrlForView(u);
  const host = stripWww(u.hostname);

  const ids = extractManifoldIdentifiers(u);
  if (!ids.instanceId && !ids.instanceSlug) {
    throw new NftLinkResolverValidationError(
      'Manifold link must include a claim slug (/c/{slug}) or an instance/claim id (?id=...).'
    );
  }

  const onManifoldHost =
    host === 'app.manifold.xyz' ||
    host.endsWith('.manifold.xyz') ||
    HOST_ALLOWLIST.MANIFOLD.has(host);

  // IMPORTANT: In phase 1 we only allow custom domains if we have an explicit instanceId.
  // This avoids SSRF/HTML crawling of arbitrary domains.
  if (!onManifoldHost && !ids.instanceId) {
    throw new NftLinkResolverValidationError(
      'For non-manifold domains, Manifold links must include ?id=<instanceId> so we can verify safely.'
    );
  }

  const requiresNetworkVerification = !onManifoldHost;

  // For custom domains, preserve the instanceId in the canonical URL to avoid collisions
  // and to keep a deterministic deep-link for the claim.
  if (requiresNetworkVerification && ids.instanceId) {
    const base = `${u.origin}${trimTrailingSlashes(u.pathname)}`;
    viewUrl = `${base}?id=${encodeURIComponent(ids.instanceId)}`;
  }

  return ok(inputUrl, 'MANIFOLD', viewUrl, { kind: 'MANIFOLD_CLAIM', ...ids });
}

/**
 * validateLinkUrl
 *
 * - NO network calls
 * - Strictly validates supported marketplaces + path shapes
 */
export function validateLinkUrl(input: string): CanonicalLink {
  const raw = cleanInputUrl(input);
  const u = safeParseUrl(raw);

  if (!u) {
    throw new NftLinkResolverValidationError('Could not parse URL.');
  }
  if (!isHttps(u)) {
    throw new NftLinkResolverValidationError(
      'Only https:// links are supported.'
    );
  }

  const host = stripWww(u.hostname);

  if (HOST_ALLOWLIST.SUPERRARE.has(host)) return parseSuperRare(u, input);
  if (HOST_ALLOWLIST.OPENSEA.has(host)) return parseOpenSea(u, input);
  if (HOST_ALLOWLIST.FOUNDATION.has(host)) return parseFoundation(u, input);
  if (HOST_ALLOWLIST.TRANSIENT.has(host)) return parseTransient(u, input);

  if (HOST_ALLOWLIST.MANIFOLD.has(host) || host.endsWith('.manifold.xyz')) {
    return parseManifold(u, input);
  }

  throw new NftLinkResolverValidationError(
    'Unsupported URL. Supported links: SuperRare, OpenSea, Foundation, Manifold, Transient.'
  );
}
