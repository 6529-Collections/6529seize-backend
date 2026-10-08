const mockSend = jest.fn();
const mockHasDevicePoster = jest.fn();
jest.mock('./has-device-poster', () => ({
  hasDeviceVideoPoster: (...args: unknown[]) => mockHasDevicePoster(...args)
}));
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
    getStringOrThrow: mockGetStringOrThrow,
    getStringOrNull: (name: string) => mockGetStringOrThrow(name)
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

const canonicalVideoKey =
  'drops/author_owner/12345678-1234-1234-1234-123456789012/clip.MP4';

describe('dropVideoConversionInvokerLoop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
    mockHasDevicePoster.mockReset().mockResolvedValue(false);
    mockPrepEnvironment.mockResolvedValue(undefined);
    mockSend.mockResolvedValue(undefined).mockResolvedValueOnce({
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
    expect(mockHasDevicePoster).not.toHaveBeenCalled();
    expect(
      settings?.OutputGroups?.[2].OutputGroupSettings?.FileGroupSettings
        ?.Destination
    ).toBe('s3://6529-test-bucket/renditions/drops/example-video/poster/');
  });

  it('skips JPEG generation when the API has already stored a validated device poster', async () => {
    mockHasDevicePoster.mockResolvedValue(true);
    await handler(
      { detail: { object: { key: canonicalVideoKey } } },
      {} as any,
      jest.fn()
    );
    const settings = jest.mocked(CreateJobCommand).mock.calls[0][0].Settings;
    expect(settings?.OutputGroups).toHaveLength(2);
  });

  it('reuses the device-poster client across warm invocations', async () => {
    const event = { detail: { object: { key: canonicalVideoKey } } };
    await handler(event, {} as any, jest.fn());
    // Reuse the same valid template for the next invocation.
    const settings = jest.mocked(CreateJobCommand).mock.calls[0][0].Settings;
    mockSend.mockResolvedValueOnce({
      JobTemplate: {
        Settings: {
          ...settings,
          OutputGroups: settings?.OutputGroups?.slice(0, 2)
        }
      }
    });
    await handler(event, {} as any, jest.fn());
    expect(mockHasDevicePoster).toHaveBeenCalledTimes(2);
    expect(mockHasDevicePoster.mock.calls[0][0]).toBe(
      mockHasDevicePoster.mock.calls[1][0]
    );
    expect(mockHasDevicePoster.mock.calls[0].slice(1)).toEqual([
      '6529-test-bucket',
      canonicalVideoKey
    ]);
    await expect(
      mockHasDevicePoster.mock.calls[0][0].config.region()
    ).resolves.toBe('eu-west-1');
  });

  it('does not submit a partially configured job when the template is unavailable', async () => {
    mockSend.mockReset().mockResolvedValueOnce({});
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
    mockSend
      .mockReset()
      .mockRejectedValueOnce(new Error('template lookup failed'));
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
    'renditions/drops/video/poster/video_poster.0000000.jpg',
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
    expect(GetJobTemplateCommand).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('preserves deployed config through secret loading and warm invocations', async () => {
    const originalGetString = mockGetStringOrThrow.getMockImplementation()!;
    mockPrepEnvironment.mockImplementation(async () => {
      mockGetStringOrThrow.mockImplementation((name) => `overridden-${name}`);
    });
    try {
      await handler(
        { detail: { object: { key: 'drops/video.mp4' } } },
        {} as any,
        jest.fn()
      );
      expect(GetJobTemplateCommand).toHaveBeenCalledWith({
        Name: 'drop-video-template'
      });
      expect(MediaConvertClient).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'eu-west-1' })
      );
      expect(
        jest.mocked(CreateJobCommand).mock.calls[0][0].Settings?.Inputs?.[0]
          .FileInput
      ).toBe('s3://6529-test-bucket/drops/video.mp4');
      mockSend.mockResolvedValueOnce({
        JobTemplate: {
          Settings: {
            OutputGroups: [
              {
                OutputGroupSettings: { Type: 'HLS_GROUP_SETTINGS' },
                Outputs: [{}]
              },
              {
                OutputGroupSettings: { Type: 'FILE_GROUP_SETTINGS' },
                Outputs: [{ ContainerSettings: { Container: 'MP4' } }]
              }
            ]
          }
        }
      });
      await handler(
        { detail: { object: { key: 'drops/another.mp4' } } },
        {} as any,
        jest.fn()
      );
      expect(jest.mocked(GetJobTemplateCommand).mock.calls[1][0]).toEqual({
        Name: 'drop-video-template'
      });
      expect(
        jest.mocked(CreateJobCommand).mock.calls[1][0].Settings?.Inputs?.[0]
          .FileInput
      ).toBe('s3://6529-test-bucket/drops/another.mp4');
    } finally {
      mockGetStringOrThrow.mockImplementation(originalGetString);
    }
  });

  it('reuses the submission token for redelivery and changes it for a new event', async () => {
    const event = {
      id: 'event-1',
      detail: { object: { key: 'drops/video.mp4' } }
    };
    // Each invocation still loads settings; job submission resolves independently.
    const response = {
      JobTemplate: {
        Settings: {
          OutputGroups: [
            {
              OutputGroupSettings: { Type: 'HLS_GROUP_SETTINGS' },
              Outputs: [{}]
            },
            {
              OutputGroupSettings: { Type: 'FILE_GROUP_SETTINGS' },
              Outputs: [{ ContainerSettings: { Container: 'MP4' } }]
            }
          ]
        }
      }
    };
    mockSend.mockReset();
    for (const id of ['event-1', 'event-1', 'event-2']) {
      mockSend.mockResolvedValueOnce(response).mockResolvedValueOnce(undefined);
      await handler({ ...event, id }, {} as any, jest.fn());
    }
    const tokens = jest
      .mocked(CreateJobCommand)
      .mock.calls.map(([input]) => input.ClientRequestToken);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });
});
