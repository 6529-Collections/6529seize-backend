import { createHash } from 'node:crypto';
import * as MP4Box from 'mp4box';
import { imageSize } from 'image-size';
import { fetchPublicUrlToBuffer } from '@/http/safe-fetch';
import {
  computeAnimationDetailsGlb,
  computeAnimationDetailsVideo,
  computeImageDetails
} from '@/minting-claims/media-inspector';
import { validGlb } from '@/tests/fixtures/glb';

jest.mock('@/http/safe-fetch', () => ({ fetchPublicUrlToBuffer: jest.fn() }));
jest.mock('image-size', () => ({ imageSize: jest.fn() }));
jest.mock('mp4box', () => ({ createFile: jest.fn() }));

describe('computed media inspection', () => {
  beforeEach(() => jest.resetAllMocks());

  function fetched(buffer: Buffer, contentType: string) {
    jest.mocked(fetchPublicUrlToBuffer).mockResolvedValue({
      buffer,
      contentType,
      finalUrl: 'https://cdn.example.com/art'
    });
  }

  it('rejects renamed text with a GLB MIME type', async () => {
    fetched(
      Buffer.from('renamed text pretending to be a model'),
      'model/gltf-binary'
    );
    await expect(
      computeAnimationDetailsGlb('https://cdn.example.com/art.glb')
    ).rejects.toThrow('Invalid GLB');
  });

  it('computes valid GLB bytes and digest using the shared download ceiling', async () => {
    const buffer = validGlb();
    fetched(buffer, 'model/gltf-binary');
    await expect(
      computeAnimationDetailsGlb('https://cdn.example.com/art.glb')
    ).resolves.toEqual({
      bytes: buffer.length,
      format: 'GLB',
      sha256: createHash('sha256').update(buffer).digest('hex')
    });
    expect(fetchPublicUrlToBuffer).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxBytes: 250_000_000 })
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid inspected image width %s',
    async (width) => {
      fetched(Buffer.from('image'), 'image/png');
      jest
        .mocked(imageSize)
        .mockReturnValue({ width, height: 100, type: 'png' });
      await expect(
        computeImageDetails('https://cdn.example.com/art.png')
      ).rejects.toThrow();
    }
  );

  function videoParser(duration: number, timescale: number, codec?: string) {
    const file = {
      onReady: (_info: unknown) => {},
      onError: (_error: unknown) => {},
      appendBuffer: jest.fn(),
      flush: () =>
        file.onReady({
          duration,
          timescale,
          tracks: [{ video: { width: 100, height: 200 }, codec }]
        })
    };
    jest
      .mocked(MP4Box.createFile)
      .mockReturnValue(file as unknown as ReturnType<typeof MP4Box.createFile>);
    fetched(Buffer.from('video'), 'video/mp4');
  }

  it.each([
    [0, 1000, 'avc1', 'duration'],
    [1000, 0, 'avc1', 'duration'],
    [Number.POSITIVE_INFINITY, 1000, 'avc1', 'duration'],
    [1000, 1000, undefined, 'codecs'],
    [1000, 1000, ' ', 'codecs']
  ])(
    'rejects invalid video inspection values %s/%s/%s',
    async (duration, timescale, codec, issue) => {
      videoParser(duration, timescale, codec);
      await expect(
        computeAnimationDetailsVideo('https://cdn.example.com/art.mp4')
      ).rejects.toThrow(issue);
    }
  );

  it('returns valid video metadata', async () => {
    videoParser(2000, 1000, 'avc1');
    await expect(
      computeAnimationDetailsVideo('https://cdn.example.com/art.mp4')
    ).resolves.toEqual(
      expect.objectContaining({
        duration: 2,
        width: 100,
        height: 200,
        codecs: ['avc1']
      })
    );
  });
});
