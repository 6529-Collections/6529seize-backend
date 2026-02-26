export const S3_UPLOADER_QUEUE_NAME = 's3-uploader-jobs';

export enum S3UploaderCollectionType {
  NFT = 'nft',
  MEME_LAB = 'meme_lab'
}

export enum S3UploaderJobType {
  IMAGE = 'image',
  VIDEO = 'video'
}

export enum S3UploaderImageVariant {
  ORIGINAL = 'original',
  SCALED_60 = 'scaled_60',
  SCALED_450 = 'scaled_450',
  SCALED_1000 = 'scaled_1000'
}

export enum S3UploaderVideoVariant {
  ORIGINAL = 'original',
  SCALED_750 = 'scaled_750'
}

export type S3UploaderJob =
  | {
      version: 1;
      reason: 'discover' | 'refresh' | 'audit';
      collectionType: S3UploaderCollectionType;
      contract: string;
      tokenId: number;
      jobType: S3UploaderJobType.IMAGE;
      variants: S3UploaderImageVariant[];
    }
  | {
      version: 1;
      reason: 'discover' | 'refresh' | 'audit';
      collectionType: S3UploaderCollectionType;
      contract: string;
      tokenId: number;
      jobType: S3UploaderJobType.VIDEO;
      variants: S3UploaderVideoVariant[];
    };

type QueueableNft = any;

export function buildS3UploaderJobsForNft({
  nft,
  collectionType,
  reason
}: {
  nft: QueueableNft;
  collectionType: S3UploaderCollectionType;
  reason: 'discover' | 'refresh' | 'audit';
}): S3UploaderJob[] {
  const jobs: S3UploaderJob[] = [];

  const imageVariants = getImageVariants(nft);
  if (imageVariants.length > 0) {
    jobs.push({
      version: 1,
      reason,
      collectionType,
      contract: nft.contract,
      tokenId: nft.id,
      jobType: S3UploaderJobType.IMAGE,
      variants: imageVariants
    });
  }

  const videoVariants = getVideoVariants(nft);
  if (videoVariants.length > 0) {
    jobs.push({
      version: 1,
      reason,
      collectionType,
      contract: nft.contract,
      tokenId: nft.id,
      jobType: S3UploaderJobType.VIDEO,
      variants: videoVariants
    });
  }

  return jobs;
}

function getImageVariants(nft: QueueableNft): S3UploaderImageVariant[] {
  const imageUrl = nft?.metadata?.image ?? nft?.metadata?.image_url;
  if (!imageUrl) {
    return [];
  }

  const variants: S3UploaderImageVariant[] = [S3UploaderImageVariant.ORIGINAL];
  if (nft.scaled) {
    variants.push(S3UploaderImageVariant.SCALED_1000);
  }
  if (nft.thumbnail) {
    variants.push(S3UploaderImageVariant.SCALED_450);
  }
  if (nft.icon) {
    variants.push(S3UploaderImageVariant.SCALED_60);
  }
  return variants;
}

function getVideoVariants(nft: QueueableNft): S3UploaderVideoVariant[] {
  const videoUrl = nft?.metadata?.animation ?? nft?.metadata?.animation_url;
  const animationDetails = parseAnimationDetails(
    nft?.metadata?.animation_details
  );
  const format = animationDetails?.format?.toUpperCase?.();
  if (!videoUrl || !['MP4', 'MOV'].includes(format ?? '')) {
    return [];
  }

  return [S3UploaderVideoVariant.ORIGINAL, S3UploaderVideoVariant.SCALED_750];
}

function parseAnimationDetails(value: any): { format?: string } | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

export function parseS3UploaderJob(messageBody: string): S3UploaderJob | null {
  if (!messageBody) {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(messageBody);
  } catch {
    return null;
  }

  if (
    parsed?.version !== 1 ||
    typeof parsed.contract !== 'string' ||
    typeof parsed.tokenId !== 'number' ||
    !Object.values(S3UploaderCollectionType).includes(parsed.collectionType) ||
    !Object.values(S3UploaderJobType).includes(parsed.jobType) ||
    !Array.isArray(parsed.variants)
  ) {
    return null;
  }

  return parsed as S3UploaderJob;
}
