import { Rememe } from './entities/IRememe';
import { ipfs } from './ipfs';

export function resolveRememeFetchImageUrl(r: Rememe): string | undefined {
  return resolveRememeFetchImageUrlFromParts(r.image, r.media?.gateway);
}

export function resolveRememeFetchImageUrlFromParts(
  image: string | undefined,
  gateway: string | undefined
): string | undefined {
  const metadataImage = ipfs
    .ifIpfsThenCloudflareElsePreserveOrEmptyIfUndefined(image)
    .trim();
  if (isFetchableUrl(metadataImage)) {
    return metadataImage;
  }

  const trimmedGateway = gateway?.trim();
  const resolved = trimmedGateway?.length ? trimmedGateway : metadataImage;
  const trimmed = resolved.trim();
  return trimmed.length ? trimmed : undefined;
}

function isFetchableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
