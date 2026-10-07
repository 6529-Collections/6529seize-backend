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
  GetJobTemplateCommand: jest.fn((input) => ({ input })),
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
  GetJobTemplateCommand,
  MediaConvertClient
} from '@aws-sdk/client-mediaconvert';
import { handler } from './index';

describe('dropVideoConversionInvokerLoop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepEnvironment.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({
      JobTemplate: {
        Settings: {
          OutputGroups: [
            {
              OutputGroupSettings: { Type: 'HLS_GROUP_SETTINGS' },
              Outputs: [{ NameModifier: '_360p' }]
            },
            {
              OutputGroupSettings: { Type: 'FILE_GROUP_SETTINGS' },
              Outputs: [
                {
                  NameModifier: '_720p',
                  ContainerSettings: { Container: 'MP4' }
                }
              ]
            }
          ]
        }
      }
    });
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
    expect(GetJobTemplateCommand).toHaveBeenCalledWith({
      Name: 'drop-video-template'
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    const settings = jest.mocked(CreateJobCommand).mock.calls[0][0].Settings;
    expect(settings?.Inputs?.[0].FileInput).toBe(
      's3://6529-test-bucket/drops/example-video.mp4'
    );
    expect(settings?.OutputGroups).toHaveLength(3);
    expect(
      settings?.OutputGroups?.[2].OutputGroupSettings?.FileGroupSettings
        ?.Destination
    ).toBe('s3://6529-test-bucket/renditions/drops/example-video/poster/');
  });

  it('does not submit a partially configured job when the template is unavailable', async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(
      handler(
        { detail: { object: { key: 'drops/video.mp4' } } },
        {} as any,
        jest.fn()
      )
    ).rejects.toThrow('has no settings');
    expect(CreateJobCommand).not.toHaveBeenCalled();
  });

  it('propagates template lookup failures for the existing Lambda retry path', async () => {
    mockSend.mockRejectedValueOnce(new Error('template lookup failed'));
    await expect(
      handler(
        { detail: { object: { key: 'drops/video.mp4' } } },
        {} as any,
        jest.fn()
      )
    ).rejects.toThrow('template lookup failed');
    expect(CreateJobCommand).not.toHaveBeenCalled();
  });

  it.each([
    'drops/example-video/hls/playlist.m3u8',
    'drops/example-video/mp4/output.mp4',
    'drops/example-image.png',
    'renditions/drops/video/mp4/video_720p.mp4',
    'renditions/drops/video/poster/video_poster.0000001.jpg',
    'nfts/video.mp4'
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
