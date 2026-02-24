import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { Logger } from '@/logging';

const logger = Logger.get('claims-builder-publisher');

let snsClient: SNSClient | null = null;

function getSnsClient(): SNSClient {
  if (snsClient === null) {
    snsClient = new SNSClient({ region: process.env.AWS_REGION });
  }
  return snsClient;
}

export async function enqueueClaimBuild(dropId: string): Promise<void> {
  const topicArn = process.env.CLAIMS_BUILDER_SNS;
  if (!topicArn) {
    throw new Error('CLAIMS_BUILDER_SNS is not configured');
  }

  const message = JSON.stringify({ drop_id: dropId });
  const response = await getSnsClient().send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: message
    })
  );

  logger.info(
    `Queued claim build for drop_id=${dropId}, messageId=${response.MessageId}`
  );
}
