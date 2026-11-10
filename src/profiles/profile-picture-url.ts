import { CLOUDFRONT_LINK } from '@/constants/media';
import { DEFAULT_MEDIA_RESOLVER_ORIGIN } from '@/decentralized-media/decentralized-media';

/** Host serving uploaded profile pictures, banners and meme thumbnails. */
export const PROFILE_MEDIA_HOST = new URL(CLOUDFRONT_LINK).hostname;
const MEDIA_RESOLVER_HOST = new URL(DEFAULT_MEDIA_RESOLVER_ORIGIN).hostname;

// A CID is a long alphanumeric token (CIDv0 "Qm..." or a CIDv1 multibase).
const IPFS_CID_PATTERN = /^[A-Za-z0-9]{20,}$/;
// File paths inside the CID, as produced by encodeURIComponent.
const IPFS_PATH_PATTERN = /^(?:\/[A-Za-z0-9._~%!*'()-]+)*\/?$/;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isPlainHttpsUrlOnHost(url: URL, host: string): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname === host &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

/** `ipfs://<cid>` (or legacy `ipfs://ipfs/<cid>`) with an optional path. */
export function isIpfsProfilePictureUrl(value: string): boolean {
  const match = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)(\/[^?#]*)?$/.exec(value);
  if (!match) return false;
  const [, cid, path = ''] = match;
  const hasDotSegment = path
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
  return (
    IPFS_CID_PATTERN.test(cid) && IPFS_PATH_PATTERN.test(path) && !hasDotSegment
  );
}

/**
 * Profile pictures are either pinned to IPFS (`ipfs://<cid>`) or served from
 * our media CDN host. Anything else, including look-alike hosts and URLs
 * with credentials or ports, is rejected.
 */
export function isAllowedProfilePictureUrl(
  value: string | null | undefined
): boolean {
  if (typeof value !== 'string') return false;
  if (value.startsWith('ipfs://')) return isIpfsProfilePictureUrl(value);
  const url = parseUrl(value);
  return url !== null && isPlainHttpsUrlOnHost(url, PROFILE_MEDIA_HOST);
}

/**
 * Images attached to push notifications must be https URLs on our media CDN,
 * or the media resolver's own IPFS gateway paths.
 */
export function isAllowedPushNotificationImageUrl(
  value: string | null | undefined
): boolean {
  if (typeof value !== 'string') return false;
  const url = parseUrl(value.trim());
  if (!url) return false;
  if (isPlainHttpsUrlOnHost(url, PROFILE_MEDIA_HOST)) return true;
  return (
    isPlainHttpsUrlOnHost(url, MEDIA_RESOLVER_HOST) &&
    url.pathname.startsWith('/ipfs/')
  );
}
