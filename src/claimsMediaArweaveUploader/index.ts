import {
  fetchMintingClaimByClaimId,
  type MintingClaimRow
} from '@/api/minting-claims/api.minting-claims.db';
import { DbPoolName } from '@/db-query.options';
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
import {
  CLAIM_MEDIA_UPLOAD_LEASE_MS,
  ClaimMediaUploadLeaseLostError,
  claimsMediaUploadLeaseDb,
  type ClaimMediaUploadLease
} from '@/minting-claims/claims-media-upload-lease.db';

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

async function clearUploadLockAfterFailure(
  lease: ClaimMediaUploadLease
): Promise<void> {
  await claimsMediaUploadLeaseDb.update(lease, { media_uploading: false });
}

async function sendUploadFailureAlert(
  contract: string,
  claimId: number,
  error: unknown
): Promise<void> {
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

async function handleUploadFailure({
  lease,
  receiveCount,
  error
}: {
  lease: ClaimMediaUploadLease;
  receiveCount: number;
  error: unknown;
}): Promise<boolean> {
  const { contract, claimId } = lease;
  const isTerminal = error instanceof BadRequestException;
  const isFinalAttempt = receiveCount >= MAX_RECEIVE_COUNT;
  if (isTerminal || isFinalAttempt) {
    try {
      await clearUploadLockAfterFailure(lease);
    } catch (rollbackError) {
      logger.error('Failed to reset media_uploading after upload failure', {
        contract,
        claimId,
        rollbackError
      });
      await sendUploadFailureAlert(contract, claimId, error);
      throw rollbackError;
    }
    await sendUploadFailureAlert(contract, claimId, error);
  }
  return isTerminal;
}

async function uploadOwnedClaim(
  lease: ClaimMediaUploadLease,
  claim: MintingClaimRow,
  receiveCount: number,
  getRemainingTimeInMillis: () => number
): Promise<void> {
  const { contract, claimId } = lease;
  await claimsMediaUploadLeaseDb.update(lease, {
    media_uploading: true
  });

  logger.info(
    `Uploading claim media to Arweave for contract=${contract} claim_id=${claimId}`
  );

  try {
    const uploadResult = await uploadMintingClaimToArweave(contract, claim, {
      beforePublish: async () => {
        assertExecutionBudget(getRemainingTimeInMillis());
        await claimsMediaUploadLeaseDb.assertHeld(lease);
      },
      onImageUploaded: async (locationUrl) => {
        await claimsMediaUploadLeaseDb.update(lease, {
          image_location: arweaveTxIdFromUrl(locationUrl)
        });
      },
      onAnimationUploaded: async (locationUrl) => {
        await claimsMediaUploadLeaseDb.update(lease, {
          animation_location: arweaveTxIdFromUrl(locationUrl)
        });
      }
    });
    await claimsMediaUploadLeaseDb.update(lease, {
      image_location: arweaveTxIdFromUrl(uploadResult.imageLocationUrl),
      animation_location: uploadResult.animationLocationUrl
        ? arweaveTxIdFromUrl(uploadResult.animationLocationUrl)
        : null,
      metadata_location: arweaveTxIdFromUrl(uploadResult.metadataLocationUrl),
      media_uploading: false
    });
  } catch (error) {
    if (error instanceof ClaimMediaUploadLeaseLostError) throw error;
    logger.error(
      `Failed to upload claim media to Arweave for contract=${contract} claim_id=${claimId}, error=${error}`
    );
    const isTerminal = await handleUploadFailure({
      lease,
      receiveCount,
      error
    });
    if (isTerminal) {
      return;
    }
    throw error;
  }
}

function assertExecutionBudget(remainingMillis: number): void {
  if (
    !Number.isFinite(remainingMillis) ||
    remainingMillis <= 5000 ||
    remainingMillis > CLAIM_MEDIA_UPLOAD_LEASE_MS - 30000
  ) {
    throw new Error(
      'Claim upload execution budget is outside the lease safety bound'
    );
  }
}

export async function processMintingClaimUpload(
  contract: string,
  claimId: number,
  receiveCount: number,
  getRemainingTimeInMillis: () => number = () => 900000
): Promise<void> {
  assertExecutionBudget(getRemainingTimeInMillis());
  const primary = { forcePool: DbPoolName.WRITE };
  const existing = await fetchMintingClaimByClaimId(contract, claimId, primary);
  if (!existing) throw new Error('Claim not found for media upload');
  if (!existing.media_uploading) return;
  const lease = await claimsMediaUploadLeaseDb.acquire(contract, claimId);
  if (!lease)
    throw new Error('Claim media upload is already owned; retry required');
  try {
    // Read again after acquisition to resume the preceding owner's latest checkpoints.
    const claim = await fetchMintingClaimByClaimId(contract, claimId, primary);
    if (!claim)
      throw new Error('Claim disappeared during media upload acquisition');
    if (!claim.media_uploading) return;
    await uploadOwnedClaim(
      lease,
      claim,
      receiveCount,
      getRemainingTimeInMillis
    );
  } finally {
    try {
      await claimsMediaUploadLeaseDb.release(lease);
    } catch {
      // Preserve the upload outcome. The bounded lease still permits recovery.
      logger.error(
        'Could not release claim media upload lease; expiry will permit retry'
      );
    }
  }
}

const sqsHandler: SQSHandler = async (event, context) => {
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
            : 1,
          () => context.getRemainingTimeInMillis()
        );
      }
    },
    { logger }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
