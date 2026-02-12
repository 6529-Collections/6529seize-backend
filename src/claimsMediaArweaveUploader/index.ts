import { getCacheKeyPatternForPath } from '@/api/api-helpers';
import {
  fetchMemeClaimByMemeId,
  updateMemeClaim
} from '@/api/memes-minting/api.memes-minting.db';
import { Logger } from '@/logging';
import {
  arweaveTxIdFromUrl,
  uploadMemeClaimToArweave
} from '@/meme-claims/claims-media-arweave-upload';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { evictAllKeysMatchingPatternFromRedisCache } from '@/redis';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSHandler } from 'aws-lambda';

const logger = Logger.get('CLAIMS_MEDIA_ARWEAVE_UPLOADER');
const ALERT_TITLE = 'Claims Media Arweave Uploader';

async function invalidateClaimCache(memeId: number): Promise<void> {
  const pattern = getCacheKeyPatternForPath(
    `/api/memes-minting/claims/${memeId}*`
  );
  try {
    await evictAllKeysMatchingPatternFromRedisCache(pattern);
  } catch (error) {
    logger.warn('Failed to invalidate meme claim cache', { memeId, error });
  }
}

function parseRecordBody(body: string): { meme_id: number } {
  const parsed = JSON.parse(body) as { meme_id?: unknown };
  const memeId = Number(parsed.meme_id);
  if (!Number.isInteger(memeId) || memeId < 1) {
    throw new Error(`Invalid message payload: ${body}`);
  }
  return { meme_id: memeId };
}

async function processMemeClaimUpload(memeId: number): Promise<void> {
  logger.info(`Processing meme claim media upload for meme_id=${memeId}`);
  const claim = await fetchMemeClaimByMemeId(memeId);
  if (!claim) {
    logger.warn(`Skipping upload - claim not found for meme_id=${memeId}`);
    return;
  }
  if (!claim.media_uploading) {
    logger.info(
      `Skipping upload - claim is not uploading for meme_id=${memeId}`
    );
    return;
  }

  await updateMemeClaim(memeId, {
    media_uploading: true
  });

  logger.info(`Uploading claim media to Arweave for meme_id=${memeId}`);

  try {
    const uploadResult = await uploadMemeClaimToArweave(memeId, claim);
    await updateMemeClaim(memeId, {
      image_location: arweaveTxIdFromUrl(uploadResult.imageLocationUrl),
      animation_location: uploadResult.animationLocationUrl
        ? arweaveTxIdFromUrl(uploadResult.animationLocationUrl)
        : null,
      metadata_location: arweaveTxIdFromUrl(uploadResult.metadataLocationUrl),
      media_uploading: false
    });
    await invalidateClaimCache(memeId);
  } catch (error) {
    logger.error(
      `Failed to upload claim media to Arweave for meme_id=${memeId}, error=${error}`
    );
    try {
      await updateMemeClaim(memeId, { media_uploading: false });
      await invalidateClaimCache(memeId);
    } catch (rollbackError) {
      logger.error('Failed to reset media_uploading after upload error', {
        memeId,
        rollbackError
      });
    }
    await priorityAlertsContext.sendPriorityAlert(ALERT_TITLE, error);
    throw error;
  }
}

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const message = parseRecordBody(record.body);
        await processMemeClaimUpload(message.meme_id);
      }
    },
    { logger }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
