import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { hasDeviceVideoPoster } from './has-device-poster';

const valid = {
  ContentType: 'image/jpeg',
  ContentLength: 1000,
  Metadata: { 'chat-video-poster': 'validated-v1' }
};
it.each([
  [valid, true],
  [{ ...valid, ContentType: 'text/html' }, false],
  [{ ...valid, ContentLength: 0 }, false],
  [{ ...valid, ContentLength: 131073 }, false],
  [{ ...valid, Metadata: {} }, false],
  [{ ...valid, Metadata: { 'chat-video-poster': 'client-claimed' } }, false]
])(
  'only accepts an API-validated nonempty JPEG (%p)',
  async (head, expected) => {
    const send = jest.fn().mockResolvedValue(head);
    expect(
      await hasDeviceVideoPoster(
        { send } as unknown as S3Client,
        'bucket',
        'drops/author/clip.MP4'
      )
    ).toBe(expected);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0][0].input.Key).toBe(
      'renditions/drops/author/clip/poster/clip_device.jpg'
    );
  }
);
it.each(['missing', 'network', 'denied'])(
  'keeps fallback capture after a %s lookup',
  async (reason) => {
    const send = jest.fn().mockRejectedValue(new Error(reason));
    expect(
      await hasDeviceVideoPoster(
        { send } as unknown as S3Client,
        'bucket',
        'drops/clip.mp4'
      )
    ).toBe(false);
  }
);
