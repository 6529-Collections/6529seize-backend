import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { randomUUID } from 'crypto';
import { Logger } from './logging';

const logger = Logger.get('NOTIFIER');

let snsClient: SNSClient;

function getSnsClient(region?: string): SNSClient {
  const regionOption = region ? { region } : {};
  if (!snsClient) {
    snsClient = new SNSClient(regionOption);
  }
  return snsClient;
}

export async function notifyTdhCalculationsDone() {
  logger.info('[NOTIFYING TDH CALCULATIONS DONE]');
  const snsQueue = process.env.TDH_CALCULATIONS_DONE_SNS;
  if (snsQueue) {
    const uid = randomUUID();
    const input = {
      TopicArn: snsQueue,
      Message: JSON.stringify({ randomId: uid }),
      MessageGroupId: uid,
      MessageDeduplicationId: uid
    };
    const response = await getSnsClient().send(new PublishCommand(input));
    logger.info(
      `Message ${input.Message} sent to SNS topic ${input.TopicArn}. MessageID is ${response.MessageId}`
    );
  } else {
    logger.info(`[SNS] [SKIPPING] [event=TdhCalculationsDone]`);
  }
}
