/**
 * Small helpers for normalizing media/metadata URIs.
 *
 * Intentionally conservative: we only rewrite well-known schemes.
 */

const IPFS_6529_GATEWAY_DOMAIN = 'ipfs.6529.io';
const IPFS_6529_GATEWAY_IPFS_PATH = `https://${IPFS_6529_GATEWAY_DOMAIN}/ipfs`;

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
  const ipfsPathMarkerIndex = lower.indexOf(ipfsPathMarker);
  if (ipfsPathMarkerIndex !== -1) {
    return to6529IpfsGatewayUrl(
      s.slice(ipfsPathMarkerIndex + ipfsPathMarker.length)
    );
  }

  if (looksLikeIpfsCid(s)) {
    return to6529IpfsGatewayUrl(s);
  }

  return s;
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

function looksLikeIpfsCid(value: string): boolean {
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|[bB][aA][fF][a-zA-Z2-7]{20,})$/.test(
    value
  );
}
