import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SQS } from './sqs';

const sendMock = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({
    send: sendMock
  })),
  SendMessageCommand: jest.fn(),
  GetQueueUrlCommand: jest.fn()
}));

describe('SQS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sendMock.mockResolvedValue({ MessageId: 'mid-123' });
    process.env.AWS_REGION = 'us-east-1';
  });

  it('adds a default message group id when sending to FIFO queues', async () => {
    const sqs = new SQS();

    await sqs.send({
      message: { hello: 'world' },
      queue: 'https://sqs.us-east-1.amazonaws.com/123/xtdh-start.fifo'
    });

    expect(SendMessageCommand).toHaveBeenCalledWith({
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/xtdh-start.fifo',
      MessageBody: JSON.stringify({ hello: 'world' }),
      MessageGroupId: 'default'
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('does not set a message group id for standard queues', async () => {
    const sqs = new SQS();

    await sqs.send({
      message: { hello: 'world' },
      queue: 'https://sqs.us-east-1.amazonaws.com/123/standard-queue'
    });

    expect(SendMessageCommand).toHaveBeenCalledWith({
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/standard-queue',
      MessageBody: JSON.stringify({ hello: 'world' })
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('uses provided message group id when supplied', async () => {
    const sqs = new SQS();

    await sqs.send({
      message: { hello: 'world' },
      queue: 'https://sqs.us-east-1.amazonaws.com/123/xtdh-start.fifo',
      messageGroupId: 'custom-group'
    });

    expect(SendMessageCommand).toHaveBeenCalledWith({
      QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/xtdh-start.fifo',
      MessageBody: JSON.stringify({ hello: 'world' }),
      MessageGroupId: 'custom-group'
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('resolves queue url by queue name and caches it', async () => {
    const sqs = new SQS();
    sendMock
      .mockResolvedValueOnce({
        QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123/s3-uploader-jobs'
      })
      .mockResolvedValueOnce({ MessageId: 'mid-123' })
      .mockResolvedValueOnce({ MessageId: 'mid-456' });

    await sqs.sendToQueueName({
      message: { hello: 'world' },
      queueName: 's3-uploader-jobs'
    });
    await sqs.sendToQueueName({
      message: { hello: 'again' },
      queueName: 's3-uploader-jobs'
    });

    expect(GetQueueUrlCommand).toHaveBeenCalledTimes(1);
    expect(GetQueueUrlCommand).toHaveBeenCalledWith({
      QueueName: 's3-uploader-jobs'
    });
    expect(SendMessageCommand).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });
});
