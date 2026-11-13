import { createHash } from 'node:crypto';
import fc from 'fast-check';
import Sharp from 'sharp';
import {
  assertPngWithinPixelCheck,
  digestDecodedPixels,
  inspectDecodedImage,
  PIXEL_CHECK_LIMITS,
  PixelCheckLimits
} from './decoded-pixel-digest';
import { pngChunk } from './fixtures/identifying-image-fixtures';
import { LosslessStripFormat } from './lossless-metadata-strip';

function gradient(width: number, height: number, channels: 3 | 4): Buffer {
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      pixels[offset] = (x * 7) & 255;
      pixels[offset + 1] = (y * 11) & 255;
      pixels[offset + 2] = (x * y) & 255;
      if (channels === 4) pixels[offset + 3] = 255 - ((x + y) & 127);
    }
  }
  return pixels;
}

const still = (width: number, height: number) =>
  Sharp(gradient(width, height, 3), { raw: { width, height, channels: 3 } });

/** Seven differently coloured frames, with distinct delays and a loop count. */
async function animatedGif(): Promise<Buffer> {
  const frames = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      Sharp({
        create: {
          width: 24,
          height: 20,
          channels: 4,
          background: { r: index * 30, g: 200 - index * 20, b: 90, alpha: 1 }
        }
      })
        .png()
        .toBuffer()
    )
  );
  return Sharp(frames, { join: { animated: true } })
    .gif({ delay: frames.map((_, index) => 40 + index * 10), loop: 3 })
    .toBuffer();
}

/** What the previous, fully buffered check hashed, without auto-rotation. */
async function fullRawDigest(input: Buffer, format: LosslessStripFormat) {
  const animated = format === 'gif' || format === 'webp';
  const metadata = await Sharp(input, { animated }).metadata();
  const { data, info } = await Sharp(input, { animated })
    .raw(metadata.depth === 'ushort' ? { depth: 'ushort' } : {})
    .toBuffer({ resolveWithObject: true });
  return {
    channels: info.channels,
    digest: createHash('sha256').update(data).digest('hex')
  };
}

function budget(limits: Partial<PixelCheckLimits> = {}) {
  return {
    limits: { ...PIXEL_CHECK_LIMITS, ...limits },
    deadline: Date.now() + 60_000
  };
}

async function digestWithBand(
  input: Buffer,
  format: LosslessStripFormat,
  bandBytes: number
) {
  const { limits, deadline } = budget({ bandBytes });
  const image = await inspectDecodedImage(input, format, limits);
  return digestDecodedPixels(input, format, image, { limits, deadline });
}

function pngHeader(width: number, height: number, bitDepth: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

describe('digestDecodedPixels', () => {
  afterEach(() => jest.restoreAllMocks());

  it('hashes any banding of a still image like its full raw pixels', async () => {
    const jpeg = await still(37, 23).jpeg().toBuffer();
    const expected = await fullRawDigest(jpeg, 'jpeg');
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 37 * 23 * 4 * 2 }),
        async (bandBytes) => {
          expect(await digestWithBand(jpeg, 'jpeg', bandBytes)).toEqual(
            expected
          );
        }
      ),
      { numRuns: 15 }
    );
  });

  it('hashes any banding of every animation frame like the full raw frames', async () => {
    const gif = await animatedGif();
    const expected = await fullRawDigest(gif, 'gif');
    // Bands of whole frames, and row ranges within one frame.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 24 * 20 * 4 * 8 }),
        async (bandBytes) => {
          expect(await digestWithBand(gif, 'gif', bandBytes)).toEqual(expected);
        }
      ),
      { numRuns: 15 }
    );
  });

  it('keeps 16-bit samples', async () => {
    const png = await still(19, 13).toColourspace('rgb16').png().toBuffer();
    const image = await inspectDecodedImage(png, 'png', PIXEL_CHECK_LIMITS);
    expect(image.depth).toBe('ushort');
    expect(await digestWithBand(png, 'png', 19 * 8 * 3)).toEqual(
      await fullRawDigest(png, 'png')
    );
  });

  it('reports orientation and hashes the stored, unrotated pixels', async () => {
    const jpeg = await still(30, 10)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const image = await inspectDecodedImage(jpeg, 'jpeg', PIXEL_CHECK_LIMITS);
    expect(image).toMatchObject({ orientation: 6, width: 30, height: 10 });
    expect(await digestWithBand(jpeg, 'jpeg', 30 * 4 * 3)).toEqual(
      await fullRawDigest(jpeg, 'jpeg')
    );
  });

  it('reports frames, frame height, timing and looping', async () => {
    const image = await inspectDecodedImage(
      await animatedGif(),
      'gif',
      PIXEL_CHECK_LIMITS
    );
    expect(image).toMatchObject({
      width: 24,
      height: 20,
      pages: 7,
      loop: 3,
      delay: '40,50,60,70,80,90,100'
    });
  });

  it('stops at the deadline', async () => {
    const jpeg = await still(8, 8).jpeg().toBuffer();
    const image = await inspectDecodedImage(jpeg, 'jpeg', PIXEL_CHECK_LIMITS);
    await expect(
      digestDecodedPixels(jpeg, 'jpeg', image, {
        limits: PIXEL_CHECK_LIMITS,
        deadline: Date.now() - 1
      })
    ).rejects.toThrow('Pixel check ran out of time');
  });
});

describe('inspectDecodedImage limits', () => {
  afterEach(() => jest.restoreAllMocks());

  it('applies the pixel ceiling to every frame together', async () => {
    const gif = await animatedGif();
    // One 480-pixel frame fits; all seven (3,360 pixels) do not.
    await expect(
      inspectDecodedImage(gif, 'gif', {
        ...PIXEL_CHECK_LIMITS,
        maxPixels: 3000
      })
    ).rejects.toThrow('Input image exceeds pixel limit');
  });

  it('bounds whole-frame decoders by frame size, but not baseline JPEG', async () => {
    const limits = { ...PIXEL_CHECK_LIMITS, maxWholeFramePixels: 800 };
    const progressive = await still(37, 23)
      .jpeg({ progressive: true })
      .toBuffer();
    const baseline = await still(37, 23).jpeg().toBuffer();
    await expect(
      inspectDecodedImage(progressive, 'jpeg', limits)
    ).rejects.toThrow('Image frame is too large to decode for the pixel check');
    await expect(
      inspectDecodedImage(baseline, 'jpeg', limits)
    ).resolves.toMatchObject({ width: 37, height: 23 });
    const webp = await still(37, 23).webp().toBuffer();
    await expect(inspectDecodedImage(webp, 'webp', limits)).rejects.toThrow(
      'Image frame is too large'
    );
    // GIF frames are 480 pixels each, under the cap.
    await expect(
      inspectDecodedImage(await animatedGif(), 'gif', limits)
    ).resolves.toMatchObject({ pages: 7 });
  });

  it.each([
    ['8-bit above 100 MP', 10_001, 10_000, 8],
    ['16-bit above 64 MP', 8_001, 8_000, 16],
    ['wider than 100,000 pixels', 100_001, 1, 8]
  ])(
    'rejects a PNG %s from IHDR before decoding',
    async (_, width, height, bitDepth) => {
      const decode = jest.spyOn(Sharp.prototype, 'metadata');
      await expect(
        inspectDecodedImage(
          pngHeader(width, height, bitDepth),
          'png',
          PIXEL_CHECK_LIMITS
        )
      ).rejects.toThrow('PNG is too large to decode for the pixel check');
      expect(decode).not.toHaveBeenCalled();
    }
  );

  it('admits PNGs at the upload PNG limits', () => {
    expect(() =>
      assertPngWithinPixelCheck(pngHeader(10_000, 10_000, 8))
    ).not.toThrow();
    expect(() =>
      assertPngWithinPixelCheck(pngHeader(8_000, 8_000, 16))
    ).not.toThrow();
  });
});
