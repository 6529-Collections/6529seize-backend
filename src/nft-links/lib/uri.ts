import {
  normalizeDecentralizedMediaUri,
  parseDecentralizedMediaRef,
  to6529ResolverUrl
} from '@/decentralized-media/decentralized-media';

/**
 * Small helpers for normalizing media/metadata URIs.
 *
 * Intentionally conservative: recognized decentralized references are routed
 * through the 6529 media resolver; unrelated URLs are preserved.
 */

export function normalizeIpfsUri(uri?: string | null): string | undefined {
  if (!uri) return undefined;
  const s = String(uri).trim();
  if (!s) return undefined;

  const ref = parseDecentralizedMediaRef(s);
  if (!ref) return s;
  if (ref.protocol !== 'ipfs' && ref.protocol !== 'ipns') return s;

  return to6529ResolverUrl(ref);
}

export function normalizeArUri(uri?: string | null): string | undefined {
  if (!uri) return undefined;
  const s = String(uri).trim();
  if (!s) return undefined;

  const ref = parseDecentralizedMediaRef(s);
  if (!ref || ref.protocol !== 'arweave') return s;

  return to6529ResolverUrl(ref);
}

export function normalizeMetadataUri(uri?: string | null): string | undefined {
  return normalizeDecentralizedMediaUri(uri);
}
