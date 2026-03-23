import { NFT_VIDEO_LINK } from '@/constants';

function isValidAnimationUrl(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || uri.startsWith('ipfs://');
  } catch {
    return false;
  }
}

export function getAnimationPaths(
  contract: string,
  tokenId: number,
  originalAnimationUrl: string | undefined,
  animationDetails: any
) {
  const parsed =
    typeof animationDetails === 'string'
      ? JSON.parse(animationDetails)
      : animationDetails;
  const ext = parsed?.format;
  const base = `${contract}/${tokenId}.${ext}`;
  if (ext === 'HTML') {
    return originalAnimationUrl && isValidAnimationUrl(originalAnimationUrl)
      ? { animation: originalAnimationUrl }
      : {};
  }
  if (['MP4', 'MOV'].includes(ext)) {
    return {
      animation: `${NFT_VIDEO_LINK}${base}`,
      compressedAnimation: `${NFT_VIDEO_LINK}${contract}/scaledx750/${tokenId}.${ext}`
    };
  }
  if (originalAnimationUrl && isValidAnimationUrl(originalAnimationUrl)) {
    return { animation: originalAnimationUrl };
  }
  return {};
}
