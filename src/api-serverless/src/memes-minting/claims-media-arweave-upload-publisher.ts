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
  memeId: number
): Promise<boolean> {
  if (!isClaimsMediaArweaveUploadActivated()) {
    logger.info(
      `Claims media Arweave upload is not activated, skipping enqueue for meme_id=${memeId}`
    );
    return false;
  }
  const topicArn = process.env.CLAIMS_MEDIA_ARWEAVE_UPLOAD_SNS;
  if (!topicArn) {
    throw new Error('CLAIMS_MEDIA_ARWEAVE_UPLOAD_SNS is not configured');
  }
  const message = JSON.stringify({ meme_id: memeId });
  const response = await getSnsClient().send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: message
    })
  );
  logger.info(
    `Queued claim media Arweave upload for meme_id=${memeId}, messageId=${response.MessageId}`
  );
  return true;
}
