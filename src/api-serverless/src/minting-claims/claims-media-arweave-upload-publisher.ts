import { Logger } from '@/logging';
import { sqs } from '@/sqs';

const logger = Logger.get('claims-media-arweave-upload-publisher');

export function isClaimsMediaArweaveUploadActivated(): boolean {
  return (
    process.env.CLAIMS_MEDIA_ARWEAVE_UPLOAD_DEACTIVATED?.toLowerCase() !==
    'true'
  );
}

export async function enqueueClaimMediaArweaveUpload(
  contract: string,
  claimId: number
): Promise<boolean> {
  if (!isClaimsMediaArweaveUploadActivated()) {
    logger.info(
      `Claims media Arweave upload is not activated, skipping enqueue for contract=${contract} claim_id=${claimId}`
    );
    return false;
  }
  const queueUrl = process.env.CLAIMS_MEDIA_ARWEAVE_UPLOAD_SQS_URL;
  if (!queueUrl) {
    throw new Error('CLAIMS_MEDIA_ARWEAVE_UPLOAD_SQS_URL is not configured');
  }
  const response = await sqs.send({
    queue: queueUrl,
    message: {
      contract: contract.toLowerCase(),
      claim_id: claimId
    }
  });
  logger.info(
    `Queued claim media Arweave upload for contract=${contract} claim_id=${claimId}, messageId=${response.MessageId}`
  );
  return true;
}
