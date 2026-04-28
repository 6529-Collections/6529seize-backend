import {
  GetQueueUrlCommand,
  SendMessageCommand,
  type SendMessageCommandOutput,
  SQSClient
} from '@aws-sdk/client-sqs';
import { env } from './env';
import { Logger } from './logging';

const DEFAULT_MESSAGE_GROUP_ID = 'default';

export class SQS {
  private readonly logger = Logger.get(this.constructor.name);
  private client: SQSClient;
  private readonly queueUrlCache = new Map<string, string>();
  private readonly queueUrlInFlight = new Map<string, Promise<string>>();

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
    messageGroupId,
    delaySeconds
  }: {
    message: any;
    queue: string;
    messageGroupId?: string;
    delaySeconds?: number;
  }): Promise<SendMessageCommandOutput> {
    const needsMessageGroupId = queue.endsWith('.fifo');
    const resolvedMessageGroupId =
      messageGroupId ?? (needsMessageGroupId ? DEFAULT_MESSAGE_GROUP_ID : null);
    const response = await this.getClient().send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: JSON.stringify(message),
        ...(typeof delaySeconds === 'number'
          ? { DelaySeconds: delaySeconds }
          : {}),
        ...(resolvedMessageGroupId && {
          MessageGroupId: resolvedMessageGroupId
        })
      })
    );
    this.logger.info(
      `Sent SQS message ${response.MessageId} to queue ${queue}  Message sent: ${response.MessageId}`
    );
    return response;
  }

  async sendToQueueName({
    message,
    queueName,
    messageGroupId,
    delaySeconds
  }: {
    message: any;
    queueName: string;
    messageGroupId?: string;
    delaySeconds?: number;
  }) {
    const queueUrl = await this.getQueueUrl(queueName);
    await this.send({ message, queue: queueUrl, messageGroupId, delaySeconds });
  }

  private async getQueueUrl(queueName: string): Promise<string> {
    const cached = this.queueUrlCache.get(queueName);
    if (cached) {
      return cached;
    }

    const inFlight = this.queueUrlInFlight.get(queueName);
    if (inFlight) {
      return await inFlight;
    }

    const request = (async () => {
      try {
        const response = await this.getClient().send(
          new GetQueueUrlCommand({
            QueueName: queueName
          })
        );
        if (!response.QueueUrl) {
          throw new Error(`Queue URL not found for queue ${queueName}`);
        }

        this.queueUrlCache.set(queueName, response.QueueUrl);
        return response.QueueUrl;
      } finally {
        this.queueUrlInFlight.delete(queueName);
      }
    })();

    this.queueUrlInFlight.set(queueName, request);
    return await request;
  }
}

export const sqs = new SQS();
