const processMock = jest.fn();
const priorityMock = jest.fn();
const diagnosticMock = jest.fn();

jest.mock('@/media/media-dependency-smoke', () => ({
  withMediaDependencySmoke: (handler: unknown) => handler
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (handler: unknown) => handler
}));
jest.mock('@/secrets', () => ({
  doInDbContext: (work: () => Promise<void>) => work()
}));
jest.mock('@/db', () => ({
  fetchNFTByContractAndId: jest.fn(async () => ({})),
  fetchMemeLabNFTByContractAndId: jest.fn()
}));
jest.mock('@/s3', () => ({ processS3UploaderJob: processMock }));
jest.mock('@/s3Uploader/s3-uploader.queue', () => ({
  isS3UploaderEnabledForEnvironment: () => true
}));
jest.mock('@/priority-alerts.context', () => ({
  wrapAsyncFunction: (_title: string, work: () => Promise<void>) => work,
  sendPriorityAlertIfConfigured: priorityMock
}));
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      errorWithDiagnostic: diagnosticMock
    })
  }
}));

import { Context, SQSEvent } from 'aws-lambda';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ImageSourceUnavailableError } from '@/media/image-download';
import { handler } from './index';

const previousLimit = process.env.S3_UPLOADER_MAX_RECEIVE_COUNT;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.S3_UPLOADER_MAX_RECEIVE_COUNT = '10';
  processMock.mockRejectedValue(
    new ImageSourceUnavailableError(5, {
      category: 'NETWORK',
      reason: 'EMPTY_BODY',
      gateway: 'arweave.net'
    })
  );
});
afterAll(() => {
  if (previousLimit === undefined)
    delete process.env.S3_UPLOADER_MAX_RECEIVE_COUNT;
  else process.env.S3_UPLOADER_MAX_RECEIVE_COUNT = previousLimit;
});

async function invoke(receiveCount: string) {
  const event = {
    Records: [
      {
        messageId: 'failed-image',
        attributes: { ApproximateReceiveCount: receiveCount },
        body: JSON.stringify({
          collectionType: 'nft',
          contract: '0xabc',
          tokenId: 558,
          jobType: 'image',
          variants: ['original'],
          reason: 'discover'
        })
      }
    ]
  } as SQSEvent;
  return handler(event, {} as Context, jest.fn());
}

it('returns failed message IDs to SQS while issuing one pending diagnostic', async () => {
  await expect(invoke('1')).resolves.toEqual({
    batchItemFailures: [{ itemIdentifier: 'failed-image' }]
  });
  expect(diagnosticMock).toHaveBeenCalledTimes(1);
  expect(diagnosticMock.mock.calls[0][0].recovery.state).toBe('pending');
  expect(priorityMock).not.toHaveBeenCalled();
});

it('keeps the last failed attempt eligible for DLQ redrive and sends the priority alert', async () => {
  await expect(invoke('10')).resolves.toEqual({
    batchItemFailures: [{ itemIdentifier: 'failed-image' }]
  });
  expect(diagnosticMock.mock.calls[0][0].recovery.state).toBe('exhausted');
  expect(priorityMock).toHaveBeenCalledTimes(1);
});

it('uses one deployment value for the runtime diagnostic and queue retry limit', () => {
  const config = parse(
    readFileSync(join(__dirname, 'serverless.yaml'), 'utf8'),
    { customTags: [{ tag: '!Sub', resolve: (value: string) => value }] }
  );
  expect(config.custom.maxReceiveCount).toBe(10);
  expect(
    config.functions.s3Uploader.environment.S3_UPLOADER_MAX_RECEIVE_COUNT
  ).toBe(
    config.resources.Resources.S3UploaderQueue.Properties.RedrivePolicy
      .maxReceiveCount
  );
});
