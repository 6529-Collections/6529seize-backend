import { Rememe } from './entities/IRememe';
import { ipfs } from './ipfs';

export type RememeMediaGateway = {
  gateway?: string | null;
};

export function resolveRememeFetchImageUrl(
  r: Pick<Rememe, 'image' | 'media'>
): string | undefined {
  return resolveRememeFetchImageUrlFromParts(
    r.image,
    gatewayFromMedia(r.media)
  );
}

export function resolveRememeFetchImageUrlFromParts(
  image: string | null | undefined,
  gateway: string | null | undefined
): string | undefined {
  const metadataImage = ipfs
    .ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(image ?? undefined)
    .trim();
  if (isFetchableUrl(metadataImage)) {
    return metadataImage;
  }

  const trimmedGateway = gateway?.trim();
  const resolved = trimmedGateway?.length ? trimmedGateway : metadataImage;
  const trimmed = resolved.trim();
  return trimmed.length ? trimmed : undefined;
}

export function isRememeFetchSourceUnchanged(
  existing: Pick<Rememe, 'image' | 'media'> | undefined,
  image: string | null | undefined,
  media: RememeMediaGateway | null | undefined
): boolean {
  if (!existing) {
    return false;
  }

  const nextGateway = gatewayFromMedia(media);
  if (!nextGateway && existing.image === image) {
    return true;
  }

  return (
    resolveRememeFetchImageUrl(existing) ===
    resolveRememeFetchImageUrlFromParts(image, nextGateway)
  );
}

function gatewayFromMedia(
  media: Rememe['media'] | RememeMediaGateway | null | undefined
): string | undefined {
  return typeof media?.gateway === 'string' ? media.gateway : undefined;
}

function isFetchableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
