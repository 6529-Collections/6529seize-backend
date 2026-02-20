import { getCacheKeyPatternForPath } from '@/api/api-helpers';
import {
  fetchMintingClaimByClaimId,
  updateMintingClaim
} from '@/api/minting-claims/api.minting-claims.db';
import { Logger } from '@/logging';
import {
  arweaveTxIdFromUrl,
  uploadMintingClaimToArweave
} from '@/minting-claims/claims-media-arweave-upload';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { evictAllKeysMatchingPatternFromRedisCache } from '@/redis';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSHandler } from 'aws-lambda';

const logger = Logger.get('CLAIMS_MEDIA_ARWEAVE_UPLOADER');
const ALERT_TITLE = 'Claims Media Arweave Uploader';

async function invalidateClaimCache(
  contract: string,
  claimId: number
): Promise<void> {
  const patterns = [
    getCacheKeyPatternForPath(
      `/api/minting-claims/${contract}/claims/${claimId}*`
    ),
    getCacheKeyPatternForPath(`/api/minting-claims/${contract}/claims*`)
  ];

  for (const pattern of patterns) {
    try {
      await evictAllKeysMatchingPatternFromRedisCache(pattern);
    } catch (error) {
      logger.warn('Failed to invalidate minting claim cache', {
        contract,
        claimId,
        pattern,
        error
      });
    }
  }
}

function parseRecordBody(body: string): { contract: string; claim_id: number } {
  const parsed = JSON.parse(body) as { contract?: unknown; claim_id?: unknown };
  const contract =
    typeof parsed.contract === 'string' ? parsed.contract.trim() : '';
  const claimId = Number(parsed.claim_id);

  if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) {
    throw new Error(`Invalid message payload: ${body}`);
  }

  if (!Number.isInteger(claimId) || claimId < 1) {
    throw new Error(`Invalid message payload: ${body}`);
  }

  return { contract: contract.toLowerCase(), claim_id: claimId };
}

async function processMintingClaimUpload(
  contract: string,
  claimId: number
): Promise<void> {
  logger.info(
    `Processing minting claim media upload for contract=${contract} claim_id=${claimId}`
  );

  const claim = await fetchMintingClaimByClaimId(contract, claimId);
  if (!claim) {
    throw new Error(
      `Claim not found for contract=${contract} claim_id=${claimId}`
    );
  }

  if (!claim.media_uploading) {
    logger.info(
      `Skipping upload - claim is not uploading for contract=${contract} claim_id=${claimId}`
    );
    return;
  }

  await updateMintingClaim(contract, claimId, {
    media_uploading: true
  });

  logger.info(
    `Uploading claim media to Arweave for contract=${contract} claim_id=${claimId}`
  );

  try {
    const uploadResult = await uploadMintingClaimToArweave(contract, claim);
    await updateMintingClaim(contract, claimId, {
      image_location: arweaveTxIdFromUrl(uploadResult.imageLocationUrl),
      animation_location: uploadResult.animationLocationUrl
        ? arweaveTxIdFromUrl(uploadResult.animationLocationUrl)
        : null,
      metadata_location: arweaveTxIdFromUrl(uploadResult.metadataLocationUrl),
      media_uploading: false
    });
    await invalidateClaimCache(contract, claimId);
  } catch (error) {
    logger.error(
      `Failed to upload claim media to Arweave for contract=${contract} claim_id=${claimId}, error=${error}`
    );
    try {
      await updateMintingClaim(contract, claimId, { media_uploading: false });
      await invalidateClaimCache(contract, claimId);
    } catch (rollbackError) {
      logger.error('Failed to reset media_uploading after upload error', {
        contract,
        claimId,
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
        await processMintingClaimUpload(message.contract, message.claim_id);
      }
    },
    { logger }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
