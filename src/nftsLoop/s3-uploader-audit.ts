import {
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  GRADIENT_CONTRACT
} from '@/constants';
import { s3ObjectExists } from '@/helpers/s3_helpers';
import { Logger } from '@/logging';
import { equalIgnoreCase } from '@/strings';
import {
  buildS3UploaderJobsForNft,
  QueueableNft,
  S3_UPLOADER_QUEUE_NAME,
  S3UploaderCollectionType,
  S3UploaderImageVariant,
  S3UploaderJob,
  S3UploaderJobType,
  S3UploaderVideoVariant
} from '@/s3Uploader/s3-uploader.jobs';
import { sqs } from '@/sqs';
import pLimit from 'p-limit';

const logger = Logger.get('S3_AUDIT');

const DEFAULT_AUDIT_S3_CHECK_CONCURRENCY = 25;
const MAX_AUDIT_S3_CHECK_CONCURRENCY = 50;

type S3ObjectExistsFn = typeof s3ObjectExists;
type AuditNftResult = {
  collection: string;
  tokenId: number;
  totalJobs: number;
  enqueuedJobs: number;
  skippedJobs: number;
};
type AuditContractSummary = {
  collection: string;
  scannedNfts: number;
  scannedJobs: number;
  enqueuedJobs: number;
  skippedJobs: number;
};

export function resolveAuditS3CheckConcurrency(
  configured: number | null
): number {
  if (configured == null || Number.isNaN(configured)) {
    return DEFAULT_AUDIT_S3_CHECK_CONCURRENCY;
  }
  return Math.max(1, Math.min(configured, MAX_AUDIT_S3_CHECK_CONCURRENCY));
}

export async function publishMissingS3UploaderAuditJobs({
  nfts,
  collectionType,
  bucket,
  concurrency,
  s3ObjectExistsFn = s3ObjectExists,
  modeLabel = 'AUDIT'
}: {
  nfts: QueueableNft[];
  collectionType: S3UploaderCollectionType;
  bucket: string;
  concurrency: number;
  s3ObjectExistsFn?: S3ObjectExistsFn;
  modeLabel?: string;
}) {
  const limit = pLimit(concurrency);
  const nftResults = await Promise.all(
    nfts.map((nft) =>
      limit(async () => {
        const { jobsToEnqueue, totalJobs } =
          await selectAuditJobsToEnqueueForNft({
            nft,
            collectionType,
            bucket,
            s3ObjectExistsFn
          });

        for (const job of jobsToEnqueue) {
          await sqs.sendToQueueName({
            queueName: S3_UPLOADER_QUEUE_NAME,
            message: job
          });
        }

        const enqueuedJobs = jobsToEnqueue.length;
        const skippedJobs = totalJobs - enqueuedJobs;
        const collection = resolveCollectionLabel(nft);

        return {
          collection,
          tokenId: nft.id,
          totalJobs,
          enqueuedJobs,
          skippedJobs
        } satisfies AuditNftResult;
      })
    )
  );

  const scannedNfts = nftResults.length;
  const scannedJobs = nftResults.reduce(
    (sum, result) => sum + result.totalJobs,
    0
  );
  const enqueuedJobs = nftResults.reduce(
    (sum, result) => sum + result.enqueuedJobs,
    0
  );
  const skippedJobs = nftResults.reduce(
    (sum, result) => sum + result.skippedJobs,
    0
  );

  const orderedNftResults = [...nftResults].sort((a, b) => {
    const collectionCmp = a.collection.localeCompare(b.collection);
    if (collectionCmp !== 0) {
      return collectionCmp;
    }
    return a.tokenId - b.tokenId;
  });
  for (const result of orderedNftResults) {
    logInfo(
      modeLabel,
      `🧪 Audit NFT ${result.collection} #${result.tokenId} [SCANNED JOBS ${result.totalJobs}] [ENQUEUED ${result.enqueuedJobs}] [NO ACTION ${result.skippedJobs}]`
    );
  }

  const contractSummaries = summarizeAuditByContract(nftResults);
  for (const summary of contractSummaries) {
    logInfo(
      modeLabel,
      `🧪 Audit collection ${summary.collection} [NFTS ${summary.scannedNfts}] [SCANNED JOBS ${summary.scannedJobs}] [ENQUEUED ${summary.enqueuedJobs}] [NO ACTION ${summary.skippedJobs}]`
    );
  }

  logInfo(
    modeLabel,
    `🧪 Audit S3 precheck complete [NFTS ${scannedNfts}] [SCANNED JOBS ${scannedJobs}] [ENQUEUED ${enqueuedJobs}] [NO ACTION ${skippedJobs}] [CONCURRENCY ${concurrency}]`
  );

  return {
    scannedNfts,
    scannedJobs,
    enqueuedJobs,
    skippedJobs,
    contractSummaries
  };
}

function logInfo(modeLabel: string, message: string) {
  logger.info(`[${modeLabel.toUpperCase()}] ${message}`);
}

function summarizeAuditByContract(
  results: AuditNftResult[]
): AuditContractSummary[] {
  const summaryByContract = new Map<string, AuditContractSummary>();
  for (const result of results) {
    const key = result.collection.toLowerCase();
    const current = summaryByContract.get(key);
    if (!current) {
      summaryByContract.set(key, {
        collection: result.collection,
        scannedNfts: 1,
        scannedJobs: result.totalJobs,
        enqueuedJobs: result.enqueuedJobs,
        skippedJobs: result.skippedJobs
      });
      continue;
    }
    current.scannedNfts += 1;
    current.scannedJobs += result.totalJobs;
    current.enqueuedJobs += result.enqueuedJobs;
    current.skippedJobs += result.skippedJobs;
  }
  return Array.from(summaryByContract.values()).sort((a, b) =>
    a.collection.localeCompare(b.collection)
  );
}

function resolveCollectionLabel(nft: QueueableNft): string {
  const collection = nft.collection?.trim();
  if (collection) {
    return collection;
  }
  return nft.contract;
}

export async function selectAuditJobsToEnqueueForNft({
  nft,
  collectionType,
  bucket,
  s3ObjectExistsFn = s3ObjectExists
}: {
  nft: QueueableNft;
  collectionType: S3UploaderCollectionType;
  bucket: string;
  s3ObjectExistsFn?: S3ObjectExistsFn;
}): Promise<{ jobsToEnqueue: S3UploaderJob[]; totalJobs: number }> {
  const jobs = buildS3UploaderJobsForNft({
    nft,
    collectionType,
    reason: 'audit'
  });
  const enqueue: S3UploaderJob[] = [];

  for (const job of jobs) {
    const shouldEnqueue = await shouldEnqueueAuditJob(
      nft,
      job,
      bucket,
      s3ObjectExistsFn
    );
    if (shouldEnqueue) {
      enqueue.push(job);
    }
  }

  return {
    jobsToEnqueue: enqueue,
    totalJobs: jobs.length
  };
}

async function shouldEnqueueAuditJob(
  nft: QueueableNft,
  job: S3UploaderJob,
  bucket: string,
  s3ObjectExistsFn: S3ObjectExistsFn
) {
  const checks = getAuditS3ChecksForJob(nft, job);
  if (!checks.length) {
    return false;
  }

  for (const check of checks) {
    const exists = await s3ObjectExistsFn(bucket, check.key, check.txId);
    if (!exists.exists) {
      return true;
    }
  }

  return false;
}

function getAuditS3ChecksForJob(
  nft: QueueableNft,
  job: S3UploaderJob
): Array<{ key: string; txId: string }> {
  if (job.jobType === S3UploaderJobType.IMAGE) {
    return getImageAuditChecks(nft, job.variants);
  }
  return getVideoAuditChecks(nft, job.variants);
}

function getImageAuditChecks(
  nft: QueueableNft,
  variants: S3UploaderImageVariant[]
) {
  const imageUrl = nft.metadata?.image ?? nft.metadata?.image_url;
  const format = resolveImageFormat(nft);
  if (!imageUrl || !format) {
    return [];
  }

  const imageTxId = getTxId(imageUrl, `${nft.contract}-${nft.id}`);
  const requested = new Set(variants);
  const checks: Array<{ key: string; txId: string }> = [];

  if (requested.has(S3UploaderImageVariant.ORIGINAL)) {
    checks.push({
      key: `images/original/${nft.contract}/${nft.id}.${format}`,
      txId: imageTxId
    });
  }

  const scaledFormat = format.toUpperCase() === 'GIF' ? 'GIF' : 'WEBP';
  if (nft.scaled && requested.has(S3UploaderImageVariant.SCALED_1000)) {
    checks.push({
      key: `images/scaled_x1000/${nft.contract}/${nft.id}.${scaledFormat}`,
      txId: imageTxId
    });
  }
  if (nft.thumbnail && requested.has(S3UploaderImageVariant.SCALED_450)) {
    checks.push({
      key: `images/scaled_x450/${nft.contract}/${nft.id}.${scaledFormat}`,
      txId: imageTxId
    });
  }
  if (nft.icon && requested.has(S3UploaderImageVariant.SCALED_60)) {
    checks.push({
      key: `images/scaled_x60/${nft.contract}/${nft.id}.${scaledFormat}`,
      txId: imageTxId
    });
  }

  return checks;
}

function getVideoAuditChecks(
  nft: QueueableNft,
  variants: S3UploaderVideoVariant[]
) {
  const videoUrl = nft.metadata?.animation ?? nft.metadata?.animation_url;
  const animationDetails = parseAnimationDetails(
    nft.metadata?.animation_details
  );
  const rawFormat = animationDetails?.format;
  const videoFormat =
    typeof rawFormat === 'string' ? rawFormat.trim().toUpperCase() : '';
  if (!videoUrl || (videoFormat !== 'MP4' && videoFormat !== 'MOV')) {
    return [];
  }

  const requested = new Set(variants);
  const videoTxId = getTxId(videoUrl, `${nft.contract}-${nft.id}`);
  const checks: Array<{ key: string; txId: string }> = [];

  if (requested.has(S3UploaderVideoVariant.ORIGINAL)) {
    checks.push({
      key: `videos/${nft.contract}/${nft.id}.${videoFormat}`,
      txId: videoTxId
    });
  }
  if (requested.has(S3UploaderVideoVariant.SCALED_750)) {
    checks.push({
      key: `videos/${nft.contract}/scaledx750/${nft.id}.${videoFormat}`,
      txId: videoTxId
    });
  }
  return checks;
}

function resolveImageFormat(nft: QueueableNft): string | null {
  if (
    equalIgnoreCase(nft.contract, MEMES_CONTRACT) ||
    equalIgnoreCase(nft.contract, MEMELAB_CONTRACT)
  ) {
    return nft.metadata?.image_details?.format ?? null;
  }
  if (equalIgnoreCase(nft.contract, GRADIENT_CONTRACT)) {
    return nft.metadata?.image?.split?.('.').pop() ?? null;
  }
  return null;
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

function getTxId(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('arweave.net')) {
      const parts = parsed.pathname.split('/');
      if (parts.length >= 2 && parts[1]) {
        return parts[1];
      }
    }

    const ipfsMatch = parsed.pathname.match(/\/ipfs\/([^/]+)/);
    if (ipfsMatch) {
      return ipfsMatch[1];
    }
  } catch {
    return fallback;
  }
  return fallback;
}
