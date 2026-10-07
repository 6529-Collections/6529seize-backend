const diagnosticMock = jest.fn();
const errorMock = jest.fn();
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({ errorWithDiagnostic: diagnosticMock, error: errorMock })
  }
}));

import { SQSRecord } from 'aws-lambda';
import { ImageSourceUnavailableError } from '@/media/image-download';
import { reportS3UploaderFailure } from './s3-uploader-failure';
import {
  S3UploaderCollectionType,
  S3UploaderImageVariant,
  S3UploaderJobType
} from './s3-uploader.jobs';

const failure = new ImageSourceUnavailableError(5, {
  category: 'NETWORK',
  reason: 'EMPTY_BODY',
  gateway: 'arweave.net',
  bytes: 0,
  httpStatus: 200
});
const job = {
  collectionType: S3UploaderCollectionType.NFT,
  contract: '0xabc',
  tokenId: 558,
  jobType: S3UploaderJobType.IMAGE,
  variants: [S3UploaderImageVariant.ORIGINAL],
  reason: 'discover'
} as const;
const originalLimit = process.env.S3_UPLOADER_MAX_RECEIVE_COUNT;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.S3_UPLOADER_MAX_RECEIVE_COUNT = '10';
});
afterAll(() => {
  if (originalLimit === undefined)
    delete process.env.S3_UPLOADER_MAX_RECEIVE_COUNT;
  else process.env.S3_UPLOADER_MAX_RECEIVE_COUNT = originalLimit;
});

function record(attempt: string) {
  return {
    messageId: 'message',
    attributes: { ApproximateReceiveCount: attempt }
  } as SQSRecord;
}

it('marks known remaining SQS retries pending and avoids an urgent priority alert', () => {
  expect(
    reportS3UploaderFailure(failure, record('1'), {
      ...job,
      variants: [...job.variants]
    })
  ).toBe(false);
  expect(diagnosticMock).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'S3_IMAGE_DOWNLOAD_EMPTY_BODY',
      resource: '0xabc:558',
      recovery: { state: 'pending', attempt: 1, maxAttempts: 10 }
    }),
    expect.stringContaining('EMPTY_BODY')
  );
});

it.each(['10', '11'])(
  'reports exhausted retries as red at receive count %s and preserves the urgent priority alert',
  (attempt) => {
    expect(reportS3UploaderFailure(failure, record(attempt), null)).toBe(true);
    expect(diagnosticMock.mock.calls[0][0].recovery.state).toBe('exhausted');
  }
);

it('keeps the penultimate delivery pending because one source-queue attempt remains', () => {
  expect(reportS3UploaderFailure(failure, record('9'), null)).toBe(false);
  expect(diagnosticMock.mock.calls[0][0].recovery).toEqual({
    state: 'pending',
    attempt: 9,
    maxAttempts: 10
  });
  expect(diagnosticMock.mock.calls[0][1]).toContain('status=200 bytes=0');
});

it('keeps unknown retry configuration red rather than promising another attempt', () => {
  delete process.env.S3_UPLOADER_MAX_RECEIVE_COUNT;
  expect(reportS3UploaderFailure(failure, record('1'), null)).toBe(true);
  expect(diagnosticMock.mock.calls[0][0].recovery.state).toBe('unknown');
});

it('preserves existing reporting for unrelated failures', () => {
  const unexpected = new Error('Access denied');
  expect(reportS3UploaderFailure(unexpected, record('1'), null)).toBe(true);
  expect(errorMock).toHaveBeenCalledWith(expect.any(String), unexpected);
  expect(diagnosticMock).not.toHaveBeenCalled();
});
