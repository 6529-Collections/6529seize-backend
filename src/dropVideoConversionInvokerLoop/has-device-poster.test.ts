import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { hasDeviceVideoPoster } from './has-device-poster';

const valid = {
  ContentType: 'image/jpeg',
  ContentLength: 1000,
  Metadata: { 'chat-video-poster': 'validated-v1' }
};
const key = 'drops/author_owner/12345678-1234-1234-1234-123456789012/clip.MP4';
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
      await hasDeviceVideoPoster({ send } as unknown as S3Client, 'bucket', key)
    ).toBe(expected);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0][0].input.Key).toBe(
      'renditions/drops/author_owner/12345678-1234-1234-1234-123456789012/clip/poster/clip_device.jpg'
    );
  }
);
it.each(['missing', 'network', 'denied'])(
  'keeps fallback capture after a %s lookup',
  async (reason) => {
    const send = jest.fn().mockRejectedValue(new Error(reason));
    expect(
      await hasDeviceVideoPoster({ send } as unknown as S3Client, 'bucket', key)
    ).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  }
);

it.each([
  'drops/clip.mp4',
  'drops/author_owner/clip.mp4',
  'drops/author_owner/not-a-uuid/clip.mp4',
  key.replace('.MP4', '.jpg'),
  key.replace('drops/', 'waves/')
])('does not request a device poster for ineligible key %s', async (key) => {
  const send = jest.fn();
  expect(
    await hasDeviceVideoPoster({ send } as unknown as S3Client, 'bucket', key)
  ).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
