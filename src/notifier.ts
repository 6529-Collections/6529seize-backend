import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { randomUUID } from 'crypto';
import { Logger } from './logging';
import { NEXTGEN_BUCKET_AWS_REGION } from './nextgen/nextgen_constants';

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

export async function notifyMissingNextgenMedia(
  path: string,
  region: string = NEXTGEN_BUCKET_AWS_REGION
) {
  logger.info(`[NOTIFYING MISSING NEXTGEN MEDIA] : [PATH ${path}]`);
  const input = {
    TopicArn:
      'arn:aws:sns:us-east-1:987989283142:nextgen-media-proxy-interceptor',
    Message: 'Object does not exist in S3.',
    MessageAttributes: {
      RequestURI: {
        DataType: 'String',
        StringValue: path
      }
    }
  };
  const response = await getSnsClient(region).send(new PublishCommand(input));
  logger.info(
    `[SNS NOTIFICATION FOR MISSING NEXTGEN MEDIA SENT] : [PATH ${path}] : [MESSAGE ID ${response.MessageId}`
  );
}
