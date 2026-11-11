import Sharp from 'sharp';
import * as lossless from './lossless-metadata-strip';
import {
  canVerifyDecodedPixels,
  stripMetadataWithPixelCheck
} from './pixel-verified-metadata-strip';
import {
  identifyingGif,
  identifyingJpeg,
  identifyingPng,
  identifyingWebp,
  pngChunk
} from './fixtures/identifying-image-fixtures';

describe('stripMetadataWithPixelCheck', () => {
  afterEach(() => jest.restoreAllMocks());

  it('admits a 76.5 MP JPEG while retaining a bounded verification budget', () => {
    const metadata = {
      width: 8500,
      height: 9000,
      channels: 3 as const,
      depth: 'uchar' as const
    };
    expect(canVerifyDecodedPixels(metadata)).toBe(true);
    expect(
      canVerifyDecodedPixels({ ...metadata, width: 17000, height: 18000 })
    ).toBe(false);
    expect(canVerifyDecodedPixels({ ...metadata, depth: 'ushort' })).toBe(
      false
    );
    expect(canVerifyDecodedPixels({ ...metadata, width: 0 })).toBe(false);
  });

  it.each<[lossless.LosslessStripFormat, () => Promise<Buffer>]>([
    ['jpeg', async () => (await identifyingJpeg()).jpeg],
    ['png', identifyingPng],
    ['webp', identifyingWebp],
    ['gif', async () => identifyingGif()]
  ])(
    'verifies a lossless %s strip by decoding both images',
    async (format, make) => {
      const input = await make();
      const outcome = await stripMetadataWithPixelCheck(input, format);
      expect(outcome).toEqual({
        kind: 'lossless',
        buffer: lossless.stripMetadataLosslessly(input, format).output,
        removed: expect.arrayContaining([expect.any(String)])
      });
    }
  );

  it('reports, rather than throws, a container it cannot strip', async () => {
    const { jpeg } = await identifyingJpeg();
    await expect(
      stripMetadataWithPixelCheck(jpeg.subarray(0, 200), 'jpeg')
    ).resolves.toEqual({ kind: 'unverified', reason: expect.any(String) });
  });

  it('rejects an output whose decoded pixels differ', async () => {
    const { jpeg } = await identifyingJpeg();
    const other = await Sharp({
      create: { width: 32, height: 16, channels: 3, background: '#000000' }
    })
      .jpeg()
      .toBuffer();
    jest.spyOn(lossless, 'stripMetadataLosslessly').mockReturnValue({
      output: other,
      input: lossless.describeImageContainer(jpeg, 'jpeg')
    });
    const outcome = await stripMetadataWithPixelCheck(jpeg, 'jpeg');
    expect(outcome).toEqual({
      kind: 'unverified',
      reason: expect.stringMatching(/^Decoded \w+ changed after stripping$/)
    });
  });

  it('declines to decode a PNG too large to compare in memory', async () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(30_000, 0);
    header.writeUInt32BE(30_000, 4);
    header[8] = 8;
    header[9] = 6;
    const huge = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', header),
      pngChunk('tEXt', Buffer.from('Author\0Jane Synthetic')),
      pngChunk('IDAT', Buffer.from('78da030000000001', 'hex')),
      pngChunk('IEND', Buffer.alloc(0))
    ]);
    const decode = jest.spyOn(Sharp.prototype, 'metadata');
    await expect(stripMetadataWithPixelCheck(huge, 'png')).resolves.toEqual({
      kind: 'unverified',
      reason: 'Image is too large to compare decoded pixels in memory'
    });
    expect(decode).not.toHaveBeenCalled();
  });
});
