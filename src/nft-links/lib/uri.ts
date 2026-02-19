/**
 * Small helpers for normalizing media/metadata URIs.
 *
 * Intentionally conservative: we only rewrite well-known schemes.
 */

export function normalizeIpfsUri(uri?: string | null): string | undefined {
  if (!uri) return undefined;
  const s = String(uri).trim();
  if (!s) return undefined;

  // Common forms:
  // - ipfs://CID
  // - ipfs://ipfs/CID
  // - https://ipfs.io/ipfs/CID
  if (s.startsWith('ipfs://')) {
    const rest = s.slice('ipfs://'.length);
    const cid = rest.startsWith('ipfs/') ? rest.slice('ipfs/'.length) : rest;
    return `https://ipfs.6529.io/ipfs/${cid}`;
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
