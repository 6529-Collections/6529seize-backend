import { WalletGalleryMediaSource } from '@/profile-cms/wallet-gallery/wallet-gallery-snapshot.types';

export interface WalletGalleryNormalizedMedia {
  readonly image: string | null;
  readonly image_preview: string | null;
  readonly thumbnail: string | null;
  readonly animation: string | null;
  readonly animation_preview: string | null;
  readonly mime_type: string | null;
}

export function normalizeWalletGalleryMedia(
  source: WalletGalleryMediaSource
): WalletGalleryNormalizedMedia {
  const animation = firstUri(source.animation, source.compressed_animation);
  const animationPreview = firstUri(
    source.compressed_animation,
    source.animation
  );
  const image = firstUri(
    source.image,
    source.scaled,
    source.thumbnail,
    source.icon
  );
  const imagePreview = firstUri(
    source.scaled,
    source.image,
    source.thumbnail,
    source.icon
  );
  const thumbnail = firstUri(
    source.thumbnail,
    source.icon,
    source.scaled,
    source.image
  );

  return {
    image,
    image_preview: imagePreview,
    thumbnail,
    animation,
    animation_preview: animationPreview,
    mime_type: inferMimeType(animation ?? image)
  };
}

function firstUri(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeUri(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeUri(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function inferMimeType(uri: string | null): string | null {
  if (!uri) {
    return null;
  }
  const lower = uri.split('?')[0].toLowerCase();
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (lower.endsWith('.webm')) {
    return 'video/webm';
  }
  return null;
}
