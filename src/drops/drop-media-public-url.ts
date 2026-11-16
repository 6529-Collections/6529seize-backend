import { CLOUDFRONT_LINK } from '@/constants/media';

const DROP_PATH = '/drops/';

export function getDropMediaPublicOrigin(): string {
  const configured = process.env.FILE_SERVER_URL;
  if (process.env.DROP_MEDIA_INGEST_STAGE !== 'staging' || !configured) {
    return CLOUDFRONT_LINK;
  }
  const url = new URL(configured);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('FILE_SERVER_URL must be an HTTPS media origin');
  }
  return url.origin;
}

export function publicUploadMediaUrl(key: string): string {
  const origin = key.startsWith('drops/')
    ? getDropMediaPublicOrigin()
    : CLOUDFRONT_LINK;
  return `${origin}/${key}`;
}

export function isDropMediaPublicUrl(url: URL): boolean {
  return (
    url.origin === CLOUDFRONT_LINK ||
    (url.pathname.startsWith(DROP_PATH) &&
      !url.username &&
      !url.password &&
      url.origin === getDropMediaPublicOrigin())
  );
}

/** Staging's CDN looks up the object in staging first, then falls back to legacy media. */
export function resolveDropMediaDeliveryUrl(value: string): string {
  const origin = getDropMediaPublicOrigin();
  if (origin === CLOUDFRONT_LINK) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (
    url.origin !== CLOUDFRONT_LINK ||
    !url.pathname.startsWith(DROP_PATH) ||
    url.username ||
    url.password
  ) {
    return value;
  }
  return `${origin}${url.pathname}${url.search}${url.hash}`;
}

export function matchDropMediaUploadUrl(
  stored: string,
  supplied: string
): boolean {
  return (
    stored === supplied ||
    resolveDropMediaDeliveryUrl(stored) ===
      resolveDropMediaDeliveryUrl(supplied)
  );
}

/** Resolve uploaded preview images embedded in proposal metadata for display. */
export function resolveAdditionalMediaPreview(value: string): string {
  if (!value.includes(CLOUDFRONT_LINK)) return value;
  try {
    const media: { preview_image?: unknown } | null = JSON.parse(value);
    if (typeof media?.preview_image !== 'string') return value;
    const previewImage = resolveDropMediaDeliveryUrl(media.preview_image);
    return previewImage === media.preview_image
      ? value
      : JSON.stringify({ ...media, preview_image: previewImage });
  } catch {
    return value;
  }
}
