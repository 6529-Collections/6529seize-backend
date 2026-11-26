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
import type { SQSHandler, SQSRecord } from 'aws-lambda';
import { BadRequestException } from '@/exceptions';
import {
  ArweaveUploadDeadlineError,
  isTerminalArweaveUploadError
} from '@/arweave/upload';
import {
  ClaimMediaUploadRecovery,
  ClaimUploadYieldError,
  claimUploadInputHash,
  restoreClaimUploadState
} from '@/minting-claims/claims-media-upload-recovery';
import { sqs } from '@/sqs';
import {
  ClaimMediaUploadLeaseLostError,
  claimsMediaUploadLeaseDb,
  type ClaimMediaUploadLease
} from '@/minting-claims/claims-media-upload-lease.db';

const logger = Logger.get('CLAIMS_MEDIA_ARWEAVE_UPLOADER');
const ALERT_TITLE = 'Claims Media Arweave Uploader';
const HANDOFF_RESERVE_MS = 60000;

export class ClaimUploadRetryError extends Error {
  constructor(
    message: string,
    readonly delaySeconds: number
  ) {
    super(message);
    this.name = 'ClaimUploadRetryError';
    Object.setPrototypeOf(this, ClaimUploadRetryError.prototype);
  }
}

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
  let parsed: { contract?: unknown; claim_id?: unknown };
  try {
    parsed = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object')
      throw new Error('invalid');
  } catch {
    throw new BadRequestException('Invalid claims upload message payload');
  }
  const contract =
    typeof parsed.contract === 'string' ? parsed.contract.trim() : '';
  const claimId = Number(parsed.claim_id);

  if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) {
    throw new BadRequestException('Invalid claims upload message contract');
  }

  if (!Number.isInteger(claimId) || claimId < 1) {
    throw new BadRequestException('Invalid claims upload message claim ID');
  }

  return { contract: contract.toLowerCase(), claim_id: claimId };
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

function assertExecutionBudget(remainingMillis: number): void {
  if (
    !Number.isFinite(remainingMillis) ||
    remainingMillis <= 5000 ||
    remainingMillis > 900000
  )
    throw new Error(
      'Claim upload execution budget is outside the lease safety bound'
    );
}

function retryDelay(failures: number): number {
  return (
    Math.min(120, 5 * 2 ** Math.min(failures, 5)) +
    Math.floor(Math.random() * 4)
  );
}

async function failOwnedClaim(
  lease: ClaimMediaUploadLease,
  recovery: ClaimMediaUploadRecovery | undefined,
  error: unknown
): Promise<void> {
  if (recovery) {
    recovery.state.status = 'failed';
    recovery.state.failure =
      error instanceof BadRequestException
        ? 'invalid-claim-or-recovery-state'
        : 'upload-failed';
    recovery.state.attemptActive = false;
  }
  await claimsMediaUploadLeaseDb.update(lease, {
    media_uploading: false,
    ...(recovery ? { media_upload_state: recovery.state } : {})
  });
  await sendUploadFailureAlert(lease.contract, lease.claimId, error);
}

async function handleOwnedUploadFailure(
  lease: ClaimMediaUploadLease,
  recovery: ClaimMediaUploadRecovery | undefined,
  error: unknown
): Promise<void> {
  await recovery?.drain();
  if (error instanceof ClaimMediaUploadLeaseLostError)
    throw new ClaimUploadRetryError(error.message, 30);
  if (
    error instanceof BadRequestException ||
    isTerminalArweaveUploadError(error)
  ) {
    await failOwnedClaim(lease, recovery, error);
    return;
  }
  const isHandoff =
    error instanceof ClaimUploadYieldError ||
    error instanceof ArweaveUploadDeadlineError;
  const madeProgress =
    recovery !== undefined &&
    recovery.state.progress > recovery.state.attemptStartProgress;
  if (recovery) {
    await recovery.finishAttempt(!isHandoff || !madeProgress);
    try {
      recovery.assertRecoverable();
    } catch (error_) {
      await failOwnedClaim(lease, recovery, error_);
      return;
    }
  }
  throw new ClaimUploadRetryError(
    error instanceof Error ? error.message : 'Claim upload retry required',
    isHandoff && madeProgress ? 2 : retryDelay(recovery?.state.failures ?? 1)
  );
}

export async function processMintingClaimUpload(
  contract: string,
  claimId: number,
  _receiveCount: number,
  getRemainingTimeInMillis: () => number = () => 900000
): Promise<void> {
  assertExecutionBudget(getRemainingTimeInMillis());
  const primary = { forcePool: DbPoolName.WRITE };
  const existing = await fetchMintingClaimByClaimId(contract, claimId, primary);
  if (!existing?.media_uploading) return;
  if (getRemainingTimeInMillis() <= HANDOFF_RESERVE_MS)
    throw new ClaimUploadRetryError('Claim upload needs a fresh invocation', 2);
  const lease = await claimsMediaUploadLeaseDb.acquire(
    contract,
    claimId,
    getRemainingTimeInMillis()
  );
  if (!lease)
    throw new ClaimUploadRetryError(
      'Claim media upload is already owned; retry required',
      await claimsMediaUploadLeaseDb.retryAfterSeconds(contract, claimId)
    );
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new ClaimUploadYieldError('Claim upload handoff before Lambda deadline')
      ),
    Math.max(1, getRemainingTimeInMillis() - HANDOFF_RESERVE_MS)
  );
  let recovery: ClaimMediaUploadRecovery | undefined;
  try {
    const claim = await fetchMintingClaimByClaimId(contract, claimId, primary);
    if (!claim?.media_uploading) return;
    recovery = new ClaimMediaUploadRecovery(
      restoreClaimUploadState(
        await claimsMediaUploadLeaseDb.loadState(lease),
        claimUploadInputHash(claim)
      ),
      (state) =>
        claimsMediaUploadLeaseDb.update(lease, { media_upload_state: state }),
      controller.signal
    );
    await recovery.begin();
    const uploadResult = await uploadMintingClaimToArweave(contract, claim, {
      beforePublish: async () => {
        controller.signal.throwIfAborted();
        if (getRemainingTimeInMillis() <= HANDOFF_RESERVE_MS)
          throw new ClaimUploadYieldError(
            'Claim upload needs a fresh invocation'
          );
        await claimsMediaUploadLeaseDb.assertHeld(lease);
      },
      publishFile: recovery.publishFile,
      beforeSourceFetch: async () => {
        controller.signal.throwIfAborted();
        // Safe fetch allows up to 120 seconds including its response body.
        if (getRemainingTimeInMillis() <= 120000 + HANDOFF_RESERVE_MS)
          throw new ClaimUploadYieldError(
            'Claim source fetch needs a fresh invocation'
          );
        await claimsMediaUploadLeaseDb.assertHeld(lease);
      },
      onImageUploaded: (locationUrl) =>
        claimsMediaUploadLeaseDb.update(lease, {
          image_location: arweaveTxIdFromUrl(locationUrl)
        }),
      onAnimationUploaded: (locationUrl) =>
        claimsMediaUploadLeaseDb.update(lease, {
          animation_location: arweaveTxIdFromUrl(locationUrl)
        })
    });
    await recovery.drain();
    await claimsMediaUploadLeaseDb.update(lease, {
      image_location: arweaveTxIdFromUrl(uploadResult.imageLocationUrl),
      animation_location: uploadResult.animationLocationUrl
        ? arweaveTxIdFromUrl(uploadResult.animationLocationUrl)
        : null,
      metadata_location: arweaveTxIdFromUrl(uploadResult.metadataLocationUrl),
      media_uploading: false,
      media_upload_state: null
    });
  } catch (error) {
    await handleOwnedUploadFailure(lease, recovery, error);
  } finally {
    clearTimeout(timer);
    await recovery?.drain();
    try {
      await claimsMediaUploadLeaseDb.release(lease);
    } catch {
      logger.error(
        'Could not release claim media upload lease; expiry will permit retry'
      );
    }
  }
}

async function shouldRetryDelivery(
  record: SQSRecord,
  error: unknown
): Promise<boolean> {
  if (error instanceof BadRequestException) {
    // No claim can be owned for malformed input. Acknowledge the poison
    // message rather than consuming the continuation receive allowance.
    try {
      await priorityAlertsContext.sendPriorityAlert(ALERT_TITLE, error);
    } catch {
      logger.error('Could not alert on malformed claim upload message');
    }
    return false;
  }
  if (!(error instanceof ClaimUploadRetryError)) {
    logger.error('Claim upload delivery failed before a controlled retry', {
      error
    });
  }
  try {
    await sqs.changeVisibility({
      queueName: record.eventSourceARN.slice(
        record.eventSourceARN.lastIndexOf(':') + 1
      ),
      receiptHandle: record.receiptHandle,
      timeoutSeconds:
        error instanceof ClaimUploadRetryError ? error.delaySeconds : 30
    });
  } catch {
    logger.error(
      'Could not adjust claim upload retry visibility; original visibility remains the fallback'
    );
  }
  return true;
}

const sqsHandler: SQSHandler = async (event, context) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        try {
          const message = parseRecordBody(record.body);
          await processMintingClaimUpload(
            message.contract,
            message.claim_id,
            Number(record.attributes.ApproximateReceiveCount) || 1,
            () => context.getRemainingTimeInMillis()
          );
        } catch (error) {
          if (await shouldRetryDelivery(record, error)) {
            batchItemFailures.push({ itemIdentifier: record.messageId });
          }
        }
      }
    },
    { logger }
  );
  return { batchItemFailures };
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
