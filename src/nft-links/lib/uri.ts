/**
 * Small helpers for normalizing media/metadata URIs.
 *
 * Intentionally conservative: we only rewrite well-known schemes.
 */

const IPFS_6529_GATEWAY_DOMAIN = 'ipfs.6529.io';
const IPFS_6529_GATEWAY_IPFS_PATH = `https://${IPFS_6529_GATEWAY_DOMAIN}/ipfs`;
const KNOWN_IPFS_GATEWAY_HOSTS = new Set([
  IPFS_6529_GATEWAY_DOMAIN,
  'ipfs.io',
  'cf-ipfs.com',
  'cloudflare-ipfs.com',
  'gateway.pinata.cloud'
]);

export function normalizeIpfsUri(uri?: string | null): string | undefined {
  if (!uri) return undefined;
  const s = String(uri).trim();
  if (!s) return undefined;

  // Common forms:
  // - ipfs://CID
  // - ipfs://ipfs/CID
  // - https://ipfs.io/ipfs/CID
  const lower = s.toLowerCase();
  if (lower.startsWith('ipfs://')) {
    return to6529IpfsGatewayUrl(s.slice('ipfs://'.length));
  }

  const ipfsPathMarker = '/ipfs/';
  const ipfsPath = getKnownGatewayIpfsPath(s, ipfsPathMarker);
  if (ipfsPath) {
    return to6529IpfsGatewayUrl(ipfsPath);
  }

  if (looksLikeIpfsCid(s)) {
    return to6529IpfsGatewayUrl(s);
  }

  return s;
}

function getKnownGatewayIpfsPath(
  uri: string,
  ipfsPathMarker: string
): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (!KNOWN_IPFS_GATEWAY_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }
  const lowerPathname = url.pathname.toLowerCase();
  const ipfsPathMarkerIndex = lowerPathname.indexOf(ipfsPathMarker);
  if (ipfsPathMarkerIndex === -1) {
    return null;
  }
  const ipfsPath = url.pathname.slice(
    ipfsPathMarkerIndex + ipfsPathMarker.length
  );
  const cid = ipfsPath.split('/')[0] ?? '';
  return looksLikeIpfsCid(cid) ? ipfsPath : null;
}

export function normalizeArUri(uri?: string | null): string | undefined {
  if (!uri) return undefined;
  const s = String(uri).trim();
  if (!s) return undefined;
  // ar://<tx> is sometimes used; arweave.net is the simplest public gateway.
  if (s.startsWith('ar://')) {
    const rest = s.slice('ar://'.length);
    return `https://arweave.net/${rest}`;
  }
  return s;
}

export function normalizeMetadataUri(uri?: string | null): string | undefined {
  // Apply in order.
  return normalizeArUri(normalizeIpfsUri(uri));
}

function to6529IpfsGatewayUrl(path: string): string {
  const normalizedPath = normalizeIpfsPath(path);
  return `${IPFS_6529_GATEWAY_IPFS_PATH}/${normalizedPath}`;
}

function normalizeIpfsPath(path: string): string {
  let normalized = path.trim();
  while (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  if (normalized.toLowerCase().startsWith('ipfs/')) {
    normalized = normalized.slice('ipfs/'.length);
  }
  return normalized;
}

/**
 * Pragmatic CID heuristic, not a full CID validator. It covers CIDv0 as "Qm"
 * plus 44 base58 characters and CIDv1 in the common base32 "baf" form. Other
 * CIDv1 multibase encodings, such as base58btc with a "z" prefix, are
 * intentionally outside this regex.
 */
function looksLikeIpfsCid(value: string): boolean {
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|[bB][aA][fF][a-zA-Z2-7]{20,})$/.test(
    value
  );
}
