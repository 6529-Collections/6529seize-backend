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
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSHandler } from 'aws-lambda';
import { BadRequestException } from '@/exceptions';

const logger = Logger.get('CLAIMS_MEDIA_ARWEAVE_UPLOADER');
const ALERT_TITLE = 'Claims Media Arweave Uploader';
const MAX_RECEIVE_COUNT = 10;

function buildUploadErrorWithContext(
  contract: string,
  claimId: number,
  error: unknown
): Error {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const contextualError = new Error(
    `Failed to upload claim media to Arweave for contract=${contract} claim_id=${claimId}: ${errorMessage}`
  );
  if (error instanceof Error) {
    contextualError.name = error.name;
    if (error.stack) {
      contextualError.stack = `${contextualError.name}: ${contextualError.message}\nCaused by: ${error.stack}`;
    }
  }
  return contextualError;
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

export async function processMintingClaimUpload(
  contract: string,
  claimId: number,
  receiveCount: number
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
    const uploadResult = await uploadMintingClaimToArweave(contract, claim, {
      onImageUploaded: async (locationUrl) => {
        await updateMintingClaim(contract, claimId, {
          image_location: arweaveTxIdFromUrl(locationUrl)
        });
      },
      onAnimationUploaded: async (locationUrl) => {
        await updateMintingClaim(contract, claimId, {
          animation_location: arweaveTxIdFromUrl(locationUrl)
        });
      }
    });
    await updateMintingClaim(contract, claimId, {
      image_location: arweaveTxIdFromUrl(uploadResult.imageLocationUrl),
      animation_location: uploadResult.animationLocationUrl
        ? arweaveTxIdFromUrl(uploadResult.animationLocationUrl)
        : null,
      metadata_location: arweaveTxIdFromUrl(uploadResult.metadataLocationUrl),
      media_uploading: false
    });
  } catch (error) {
    logger.error(
      `Failed to upload claim media to Arweave for contract=${contract} claim_id=${claimId}, error=${error}`
    );
    const isTerminalValidationFailure = error instanceof BadRequestException;
    if (isTerminalValidationFailure) {
      await updateMintingClaim(contract, claimId, { media_uploading: false });
    } else if (receiveCount >= MAX_RECEIVE_COUNT) {
      try {
        await updateMintingClaim(contract, claimId, { media_uploading: false });
      } catch (rollbackError) {
        logger.error('Failed to reset media_uploading after final retry', {
          contract,
          claimId,
          rollbackError
        });
      }
    }
    if (
      isTerminalValidationFailure ||
      receiveCount === 1 ||
      receiveCount >= MAX_RECEIVE_COUNT
    ) {
      try {
        await priorityAlertsContext.sendPriorityAlert(
          ALERT_TITLE,
          buildUploadErrorWithContext(contract, claimId, error)
        );
      } catch (alertError) {
        logger.error('Failed to send claims media upload priority alert', {
          contract,
          claimId,
          alertError
        });
      }
    }
    if (isTerminalValidationFailure) {
      return;
    }
    throw error;
  }
}

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const message = parseRecordBody(record.body);
        const receiveCount = Number(record.attributes.ApproximateReceiveCount);
        await processMintingClaimUpload(
          message.contract,
          message.claim_id,
          Number.isSafeInteger(receiveCount) && receiveCount > 0
            ? receiveCount
            : 1
        );
      }
    },
    { logger }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
