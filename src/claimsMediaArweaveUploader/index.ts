import type { SQSHandler } from 'aws-lambda';
import {
  fetchMemeClaimByMemeId,
  updateMemeClaim
} from '@/api/memes-minting/api.memes-minting.db';
import {
  arweaveTxIdFromUrl,
  uploadMemeClaimToArweave
} from '@/meme-claims/claims-media-arweave-upload';
import { Logger } from '@/logging';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';

const logger = Logger.get('CLAIMS_MEDIA_ARWEAVE_UPLOADER');
const ALERT_TITLE = 'Claims Media Arweave Uploader';

function parseRecordBody(body: string): { meme_id: number } {
  const parsed = JSON.parse(body) as { meme_id?: unknown };
  const memeId = Number(parsed.meme_id);
  if (!Number.isInteger(memeId) || memeId < 1) {
    throw new Error(`Invalid message payload: ${body}`);
  }
  return { meme_id: memeId };
}

async function processMemeClaimUpload(memeId: number): Promise<void> {
  const claim = await fetchMemeClaimByMemeId(memeId);
  if (!claim) {
    logger.warn(`Skipping upload - claim not found for meme_id=${memeId}`);
    return;
  }
  if (claim.arweave_synced_at != null) {
    if (claim.media_uploading) {
      await updateMemeClaim(memeId, { media_uploading: false });
    }
    logger.info(
      `Skipping upload - claim already synced for meme_id=${memeId} (arweave_synced_at=${claim.arweave_synced_at})`
    );
    return;
  }

  await updateMemeClaim(memeId, { media_uploading: true });

  try {
    const uploadResult = await uploadMemeClaimToArweave(memeId, claim);
    await updateMemeClaim(memeId, {
      image_location: arweaveTxIdFromUrl(uploadResult.imageLocationUrl),
      animation_location: uploadResult.animationLocationUrl
        ? arweaveTxIdFromUrl(uploadResult.animationLocationUrl)
        : null,
      metadata_location: arweaveTxIdFromUrl(uploadResult.metadataLocationUrl),
      arweave_synced_at: Date.now(),
      media_uploading: false
    });
  } catch (error) {
    await updateMemeClaim(memeId, { media_uploading: false });
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
