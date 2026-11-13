import type { Context, SQSHandler, SQSRecord } from 'aws-lambda';
import { handler } from './index';
import { dropMediaSanitizerService } from '@/drops/drop-media-sanitizer.service';

jest.mock('@/media/media-dependency-smoke', () => ({
  withMediaDependencySmoke: (fn: SQSHandler) => fn
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: SQSHandler) => fn
}));
jest.mock('@/secrets', () => ({
  doInDbContext: (fn: () => Promise<void>) => fn()
}));
jest.mock('@/drops/drop-media-sanitizer.service', () => ({
  dropMediaSanitizerService: { processUpload: jest.fn() }
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: jest.fn() }) }
}));

function record(body: string): SQSRecord {
  return {
    messageId: 'local-message',
    receiptHandle: 'local-receipt',
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '0',
      SenderId: 'local-sender',
      ApproximateFirstReceiveTimestamp: '0'
    },
    messageAttributes: {},
    md5OfBody: 'local-digest',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:local',
    awsRegion: 'us-east-1'
  };
}

describe('drop media sanitizer retry messages', () => {
  beforeEach(() => {
    jest
      .mocked(dropMediaSanitizerService.processUpload)
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it.each([undefined, false, true])(
    'only retries failed uploads for an explicit boolean true (%s)',
    async (retryFailed) => {
      const body = JSON.stringify({
        media_upload_id: 'local-upload',
        retry_failed: retryFailed
      });
      const result = await handler(
        { Records: [record(body)] },
        {} as Context,
        () => undefined
      );
      expect(dropMediaSanitizerService.processUpload).toHaveBeenCalledWith({
        mediaUploadId: 'local-upload',
        retryFailed: retryFailed === true,
        approximateReceiveCount: 1
      });
      expect(result).toEqual({ batchItemFailures: [] });
    }
  );

  it('refuses a malformed retry flag without processing the image', async () => {
    const result = await handler(
      {
        Records: [
          record(
            JSON.stringify({
              media_upload_id: 'local-upload',
              retry_failed: 'true'
            })
          )
        ]
      },
      {} as Context,
      () => undefined
    );
    expect(dropMediaSanitizerService.processUpload).not.toHaveBeenCalled();
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'local-message' }]
    });
  });
});
