import { Logger } from '@/logging';
import { NFT_VIDEO_LINK } from '@/constants';

const logger = Logger.get('NFT_ANIMATION_PATHS');

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
  const parsed = parseAnimationDetails(animationDetails, contract, tokenId);
  const ext = parsed?.format;
  const base = `${contract}/${tokenId}.${ext}`;
  if (ext === 'HTML') {
    return originalAnimationUrl && isValidAnimationUrl(originalAnimationUrl)
      ? { animation: originalAnimationUrl }
      : {};
  }
  if (ext === 'MP4' || ext === 'MOV') {
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

function parseAnimationDetails(
  animationDetails: unknown,
  contract: string,
  tokenId: number
): { format?: string } | null {
  if (!animationDetails) {
    return null;
  }
  if (typeof animationDetails !== 'string') {
    return animationDetails as { format?: string };
  }
  try {
    return JSON.parse(animationDetails) as { format?: string };
  } catch (error) {
    logger.warn(
      `[ANIMATION_DETAILS_PARSE_FAILED] [contract ${contract}] [token_id ${tokenId}]`,
      error
    );
    return null;
  }
}
