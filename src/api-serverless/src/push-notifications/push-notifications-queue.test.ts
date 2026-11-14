import type { SQSClient as SqsClientType } from '@aws-sdk/client-sqs';

const sendMock = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({ send: sendMock })),
  GetQueueUrlCommand: jest.fn().mockImplementation((params) => params)
}));

async function loadModule() {
  const { SQSClient } = await import('@aws-sdk/client-sqs');
  const queue = await import('./push-notifications-queue');
  const sqs: SqsClientType = new SQSClient({});
  return { queue, sqs };
}

describe('getPushNotificationsQueueUrl', () => {
  beforeEach(() => {
    jest.resetModules();
    sendMock.mockReset();
  });

  it('looks the queue up by name in the current account once', async () => {
    sendMock.mockResolvedValue({
      QueueUrl: 'https://sqs.eu-west-1.amazonaws.com/111122223333/q'
    });
    const { queue, sqs } = await loadModule();

    await expect(queue.getPushNotificationsQueueUrl(sqs)).resolves.toBe(
      'https://sqs.eu-west-1.amazonaws.com/111122223333/q'
    );
    await queue.getPushNotificationsQueueUrl(sqs);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      QueueName: 'firebase-push-notifications'
    });
  });

  it('retries the lookup after a failure', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('SQS unavailable'))
      .mockResolvedValueOnce({ QueueUrl: 'https://sqs.example/q' });
    const { queue, sqs } = await loadModule();

    await expect(queue.getPushNotificationsQueueUrl(sqs)).rejects.toThrow(
      'SQS unavailable'
    );
    await expect(queue.getPushNotificationsQueueUrl(sqs)).resolves.toBe(
      'https://sqs.example/q'
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a response without a queue URL', async () => {
    sendMock.mockResolvedValue({});
    const { queue, sqs } = await loadModule();

    await expect(queue.getPushNotificationsQueueUrl(sqs)).rejects.toThrow(
      'SQS returned no URL for queue firebase-push-notifications'
    );
  });
});
