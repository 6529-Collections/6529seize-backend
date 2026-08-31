const processNextRequest = jest.fn();
const cleanupCompletedRequests = jest.fn();
const sendWakeup = jest.fn();
const processInteraction = jest.fn();
const loggerError = jest.fn();

jest.mock('@/help-bot/help-bot-daily-activity-credit-queue.service', () => ({
  HELP_BOT_DAILY_ACTIVITY_CREDITS_QUEUE_NAME:
    'help-bot-daily-activity-credits.fifo',
  helpBotDailyActivityCreditQueueService: {
    processNextRequest,
    cleanupCompletedRequests,
    sendWakeup
  }
}));
jest.mock('@/help-bot/help-bot-processor.service', () => ({
  helpBotProcessorService: { processInteraction }
}));
jest.mock('@/logging', () => ({
  Logger: {
    get: jest.fn(() => ({ info: jest.fn(), error: loggerError }))
  }
}));
jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (callback: () => Promise<void>) => callback())
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: jest.fn((handler) => handler)
}));

import type { SQSEvent } from 'aws-lambda';
import {
  dailyActivityCreditHandler,
  DEAD_DAILY_ACTIVITY_CREDIT_REQUEST_LOG_MARKER,
  handler,
  processDailyActivityCreditWakeup
} from './index';

function createSqsEvent(queueName: string, body: string): SQSEvent {
  return {
    Records: [
      {
        messageId: 'message-1',
        receiptHandle: 'receipt-1',
        body,
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '0',
          SenderId: 'sender-1',
          ApproximateFirstReceiveTimestamp: '0'
        },
        messageAttributes: {},
        md5OfBody: 'md5',
        eventSource: 'aws:sqs',
        eventSourceARN: `arn:aws:sqs:eu-west-1:123456789012:${queueName}`,
        awsRegion: 'eu-west-1'
      }
    ]
  };
}

describe('helpBotReplyLoop daily activity credits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cleanupCompletedRequests.mockResolvedValue(undefined);
    sendWakeup.mockResolvedValue(undefined);
    processInteraction.mockResolvedValue(undefined);
  });

  it('processes the credit FIFO independently from normal bot replies', async () => {
    processNextRequest.mockResolvedValue({
      processed: false,
      failed: false,
      dead: false,
      hasMore: false
    });

    await dailyActivityCreditHandler(
      createSqsEvent('help-bot-daily-activity-credits.fifo', '{}'),
      {} as never,
      jest.fn()
    );

    expect(processNextRequest).toHaveBeenCalledTimes(1);
    expect(processInteraction).not.toHaveBeenCalled();
  });

  it('preserves normal reply-queue processing', async () => {
    await handler(
      createSqsEvent(
        'help-bot-replies',
        JSON.stringify({ interaction_id: 'interaction-1' })
      ),
      {} as never,
      jest.fn()
    );

    expect(processInteraction).toHaveBeenCalledWith('interaction-1', {});
    expect(processNextRequest).not.toHaveBeenCalled();
  });

  it('queues a continuation while eligible durable requests remain', async () => {
    processNextRequest.mockResolvedValue({
      processed: true,
      failed: false,
      dead: false,
      hasMore: true
    });

    await processDailyActivityCreditWakeup();

    expect(cleanupCompletedRequests).toHaveBeenCalledTimes(1);
    expect(sendWakeup).toHaveBeenCalledTimes(1);
  });

  it('acknowledges the wakeup after recording a durable retry', async () => {
    processNextRequest.mockResolvedValue({
      processed: false,
      failed: true,
      dead: false,
      hasMore: false
    });

    await expect(
      processDailyActivityCreditWakeup()
    ).resolves.toBeUndefined();
    expect(sendWakeup).not.toHaveBeenCalled();
  });

  it('emits the terminal marker and acknowledges a parked dead request', async () => {
    const result = {
      processed: false,
      failed: true,
      dead: true,
      hasMore: false
    };
    processNextRequest.mockResolvedValue(result);

    await expect(processDailyActivityCreditWakeup()).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      DEAD_DAILY_ACTIVITY_CREDIT_REQUEST_LOG_MARKER,
      { result }
    );
  });
});
