import Sharp from 'sharp';
import * as lossless from './lossless-metadata-strip';
import {
  canVerifyDecodedPixels,
  PIXEL_CHECK_LIMITS,
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

  it('admits a 76.5 MP JPEG at admission while bounding what the check decodes', () => {
    const jpeg = {
      format: 'jpeg' as const,
      width: 8500,
      height: 9000,
      depth: 'uchar' as const,
      isProgressive: false
    };
    expect(canVerifyDecodedPixels(jpeg)).toBe(true);
    // The 268 MP (16384 x 16384) decoded-pixel ceiling.
    expect(
      canVerifyDecodedPixels({ ...jpeg, width: 16384, height: 16384 })
    ).toBe(true);
    expect(
      canVerifyDecodedPixels({ ...jpeg, width: 17000, height: 18000 })
    ).toBe(false);
    // Whole-frame decoders stop at 64 MP; so does an unknown format.
    expect(canVerifyDecodedPixels({ ...jpeg, isProgressive: true })).toBe(
      false
    );
    expect(canVerifyDecodedPixels({ ...jpeg, format: undefined })).toBe(false);
    // PNG keeps the upload limits: 100 MP at 8 bits, 64 MP at 16 bits.
    expect(canVerifyDecodedPixels({ ...jpeg, format: 'png' })).toBe(true);
    expect(
      canVerifyDecodedPixels({ ...jpeg, format: 'png', depth: 'ushort' })
    ).toBe(false);
    expect(canVerifyDecodedPixels({ ...jpeg, width: 0 })).toBe(false);
  });

  it('counts every GIF or WebP page at admission, from either load', () => {
    const frame = { format: 'gif' as const, width: 500, height: 500 };
    // 1,000 frames (250 MP) fit the ceiling; 1,100 (275 MP) do not.
    expect(canVerifyDecodedPixels({ ...frame, pages: 1000 })).toBe(true);
    expect(canVerifyDecodedPixels({ ...frame, pages: 1100 })).toBe(false);
    expect(
      canVerifyDecodedPixels({
        ...frame,
        height: 500 * 1100,
        pageHeight: 500,
        pages: 1100
      })
    ).toBe(false);
    expect(
      canVerifyDecodedPixels({ ...frame, format: 'webp', pages: 1100 })
    ).toBe(false);
  });

  it('rejects at admission what the check itself would not verify', async () => {
    const limits = { maxWholeFramePixels: 400 };
    const { jpeg } = await identifyingJpeg();
    const metadata = await Sharp(jpeg).metadata();
    expect(
      canVerifyDecodedPixels(metadata, {
        ...PIXEL_CHECK_LIMITS,
        ...limits
      })
    ).toBe(false);
    await expect(
      stripMetadataWithPixelCheck(jpeg, 'jpeg', { limits })
    ).resolves.toEqual({
      kind: 'unverified',
      reason: 'Image frame is too large to decode for the pixel check'
    });
    expect(canVerifyDecodedPixels(metadata)).toBe(true);
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

  it('declines to decode a PNG above the upload PNG limits', async () => {
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
      reason: 'PNG is too large to decode for the pixel check'
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it('reports a source above the caller limit without parsing it', async () => {
    const { jpeg } = await identifyingJpeg();
    const strip = jest.spyOn(lossless, 'stripMetadataLosslessly');
    await expect(
      stripMetadataWithPixelCheck(jpeg, 'jpeg', {
        maxSourceBytes: jpeg.length - 1
      })
    ).resolves.toEqual({
      kind: 'unverified',
      reason: 'Source is larger than the lossless strip limit'
    });
    expect(strip).not.toHaveBeenCalled();
  });

  it('reports a decode that runs out of time', async () => {
    const { jpeg } = await identifyingJpeg();
    await expect(
      stripMetadataWithPixelCheck(jpeg, 'jpeg', { limits: { timeBudgetMs: 0 } })
    ).resolves.toEqual({
      kind: 'unverified',
      reason: 'Pixel check ran out of time'
    });
  });
});
