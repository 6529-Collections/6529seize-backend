import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { env } from './env';
import { Logger } from './logging';

const DEFAULT_MESSAGE_GROUP_ID = 'default';

export class SQS {
  private readonly logger = Logger.get(this.constructor.name);
  private client: SQSClient;

  private getClient() {
    if (!this.client) {
      this.client = new SQSClient({
        region: env.getStringOrThrow('AWS_REGION')
      });
    }
    return this.client;
  }

  async send({
    message,
    queue,
    messageGroupId
  }: {
    message: any;
    queue: string;
    messageGroupId?: string;
  }) {
    const needsMessageGroupId = queue.endsWith('.fifo');
    const resolvedMessageGroupId =
      messageGroupId ?? (needsMessageGroupId ? DEFAULT_MESSAGE_GROUP_ID : null);
    const response = await this.getClient().send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: JSON.stringify(message),
        ...(resolvedMessageGroupId && {
          MessageGroupId: resolvedMessageGroupId
        })
      })
    );
    this.logger.info(
      `Sent SQS message ${response.MessageId} to queue ${queue}  Message sent: ${response.MessageId}`
    );
  }
}

export const sqs = new SQS();
