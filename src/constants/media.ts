export const CLOUDFRONT_DISTRIBUTION = 'ECGWRHUV1NM3I';
export const CLOUDFRONT_ID = 'd3lqz0a4bldqgf';
export const CLOUDFRONT_LINK = `https://${CLOUDFRONT_ID}.cloudfront.net`;

/**
 * Origin of the CDN that serves user uploads (drops, waves, profile pictures,
 * banners) in this environment, taken from FILE_SERVER_URL. Prod sets it to
 * CLOUDFRONT_LINK; staging sets its own media host. Falls back to
 * CLOUDFRONT_LINK when unset or not an https URL.
 *
 * Read on every call: secrets are loaded after modules are imported.
 */
export function getUserMediaOrigin(): string {
  const configured = process.env.FILE_SERVER_URL;
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:') {
        return url.origin;
      }
    } catch {
      // Not a URL: use the default.
    }
  }
  return CLOUDFRONT_LINK;
}

/**
 * Origins accepted as platform-hosted media: this environment's media CDN and
 * the prod CDN, which older data in every environment points to. In prod both
 * are the same origin.
 */
export function getAcceptedMediaOrigins(): string[] {
  const own = getUserMediaOrigin();
  return own === CLOUDFRONT_LINK ? [CLOUDFRONT_LINK] : [own, CLOUDFRONT_LINK];
}

export function isAcceptedMediaOrigin(origin: string): boolean {
  return getAcceptedMediaOrigins().includes(origin);
}

/** An https URL on an accepted media origin, written without port or userinfo. */
export function isAcceptedMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      isAcceptedMediaOrigin(url.origin) && value.startsWith(`${url.origin}/`)
    );
  } catch {
    return false;
  }
}

export const NFT_ORIGINAL_IMAGE_LINK = `${CLOUDFRONT_LINK}/images/original/`;

export const NFT_SCALED1000_IMAGE_LINK = `${CLOUDFRONT_LINK}/images/scaled_x1000/`;

export const NFT_SCALED450_IMAGE_LINK = `${CLOUDFRONT_LINK}/images/scaled_x450/`;

export const NFT_SCALED60_IMAGE_LINK = `${CLOUDFRONT_LINK}/images/scaled_x60/`;

export const NFT_VIDEO_LINK = `${CLOUDFRONT_LINK}/videos/`;
export const NFT_HTML_LINK = `${CLOUDFRONT_LINK}/html/`;
