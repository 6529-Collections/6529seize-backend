import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { Logger } from '@/logging';

const logger = Logger.get('claims-media-arweave-upload-publisher');

let snsClient: SNSClient | null = null;

function getSnsClient(): SNSClient {
  if (snsClient === null) {
    snsClient = new SNSClient({ region: process.env.AWS_REGION });
  }
  return snsClient;
}

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
  const topicArn = process.env.CLAIMS_MEDIA_ARWEAVE_UPLOAD_SNS;
  if (!topicArn) {
    throw new Error('CLAIMS_MEDIA_ARWEAVE_UPLOAD_SNS is not configured');
  }
  const message = JSON.stringify({
    contract: contract.toLowerCase(),
    claim_id: claimId
  });
  const response = await getSnsClient().send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: message
    })
  );
  logger.info(
    `Queued claim media Arweave upload for contract=${contract} claim_id=${claimId}, messageId=${response.MessageId}`
  );
  return true;
}
