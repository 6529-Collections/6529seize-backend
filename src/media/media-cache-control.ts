/**
 * Cache-Control values stored on public media objects when they are written.
 * The media CloudFront distribution also serves the desktop app's update feeds,
 * which must stay uncached, so these values are set per media object at write
 * time and never as a distribution-wide default.
 */

/**
 * For keys that never receive different bytes: each upload gets a fresh random
 * key, or the writer only ever creates the key once.
 */
export const IMMUTABLE_MEDIA_CACHE_CONTROL =
  'public, max-age=31536000, immutable';

/**
 * For stable per-token keys that are rewritten in place (followed by a
 * CloudFront invalidation) when the token's source media changes. Browsers
 * reuse their copy for a day, then revalidate it with the stored ETag.
 */
export const REWRITABLE_MEDIA_CACHE_CONTROL = 'public, max-age=86400';
