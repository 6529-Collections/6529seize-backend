import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { env } from './env';
import { Logger } from './logging';

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

  async send({ message, queue }: { message: any; queue: string }) {
    const response = await this.getClient().send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: JSON.stringify(message)
      })
    );
    this.logger.info(
      `Sent SQS message ${response.MessageId} to queue ${queue}  Message sent: ${response.MessageId}`
    );
  }
}

export const sqs = new SQS();
