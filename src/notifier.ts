import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { randomUUID } from 'crypto';
import { Logger } from './logging';

const logger = Logger.get('NOTIFIER');

let snsClient: SNSClient;

function getSnsClient(): SNSClient {
  if (!snsClient) {
    snsClient = new SNSClient({ region: 'us-east-1' });
  }
  return snsClient;
}

export async function notifyTdhCalculationsDone() {
  logger.info('[NOTIFYING TDH CALCULATIONS DONE]');
  if (process.env.NODE_ENV == 'production') {
    const uid = randomUUID();
    const input = {
      TopicArn: 'arn:aws:sns:us-east-1:987989283142:tdh-calculation-done.fifo',
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
