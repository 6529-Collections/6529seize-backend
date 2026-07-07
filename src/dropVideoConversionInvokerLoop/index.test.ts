const mockSend = jest.fn();
const mockPrepEnvironment = jest.fn();
const mockDoInDbContext = jest.fn();
const mockLoggerInfo = jest.fn();
const mockGetStringOrThrow = jest.fn((name: string) => {
  const values: Record<string, string> = {
    MC_ENDPOINT: 'https://mediaconvert.example.com',
    MC_ROLE_ARN: 'arn:aws:iam::123456789012:role/media-convert',
    MC_DROPS_VIDEO_TEMPLATE_NAME: 'drop-video-template',
    S3_BUCKET: '6529-test-bucket',
    BUCKET_REGION: 'eu-west-1'
  };
  return values[name];
});

jest.mock('@aws-sdk/client-mediaconvert', () => ({
  CreateJobCommand: jest.fn((input) => ({ input })),
  MediaConvertClient: jest.fn(() => ({ send: mockSend }))
}));

jest.mock('../env', () => ({
  env: {
    getStringOrThrow: mockGetStringOrThrow
  },
  prepEnvironment: mockPrepEnvironment
}));

jest.mock('../logging', () => ({
  Logger: {
    get: jest.fn(() => ({
      info: mockLoggerInfo
    }))
  }
}));

jest.mock('../secrets', () => ({
  doInDbContext: mockDoInDbContext
}));

jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: jest.fn((handler) => handler)
}));

jest.mock('../time', () => ({
  Time: {
    now: jest.fn(() => ({
      diffFromNow: () => ({
        formatAsDuration: () => '1ms'
      })
    }))
  }
}));

import {
  CreateJobCommand,
  MediaConvertClient
} from '@aws-sdk/client-mediaconvert';
import { handler } from './index';

describe('dropVideoConversionInvokerLoop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepEnvironment.mockResolvedValue(undefined);
    mockSend.mockResolvedValue(undefined);
  });

  it('invokes MediaConvert without opening a DB context', async () => {
    await handler(
      {
        detail: {
          object: {
            key: 'drops/example-video.mp4'
          }
        }
      },
      {} as any,
      jest.fn()
    );

    expect(mockPrepEnvironment).toHaveBeenCalledTimes(1);
    expect(mockDoInDbContext).not.toHaveBeenCalled();
    expect(MediaConvertClient).toHaveBeenCalledWith({
      region: 'eu-west-1',
      endpoint: 'https://mediaconvert.example.com'
    });
    expect(CreateJobCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Role: 'arn:aws:iam::123456789012:role/media-convert',
        JobTemplate: 'drop-video-template'
      })
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    'drops/example-video/hls/playlist.m3u8',
    'drops/example-video/mp4/output.mp4',
    'drops/example-image.png'
  ])('does not invoke MediaConvert for skipped key %s', async (key) => {
    await handler(
      {
        detail: {
          object: {
            key
          }
        }
      },
      {} as any,
      jest.fn()
    );

    expect(mockPrepEnvironment).toHaveBeenCalledTimes(1);
    expect(mockDoInDbContext).not.toHaveBeenCalled();
    expect(MediaConvertClient).not.toHaveBeenCalled();
    expect(CreateJobCommand).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
