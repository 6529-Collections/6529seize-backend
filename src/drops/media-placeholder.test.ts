import fc from 'fast-check';
import Sharp from 'sharp';
import { describeImage, orientedSize } from './media-placeholder';
import { rgbaToThumbHash } from './thumbhash-encoder';

/** Header fields of a ThumbHash, as the reference decoder reads them. */
function thumbHashHeader(base64: string) {
  const hash = Buffer.from(base64, 'base64');
  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const header16 = hash[3] | (hash[4] << 8);
  const isLandscape = header16 >> 15 !== 0;
  const hasAlpha = header24 >> 23 !== 0;
  const lMax = hasAlpha ? 5 : 7;
  const lMin = header16 & 7;
  const lx = isLandscape ? lMax : lMin;
  const ly = isLandscape ? lMin : lMax;
  return {
    aspectRatio: lx / ly,
    averageLuminance: (header24 & 63) / 63,
    hasAlpha
  };
}

/** Deterministic test image: horizontal red ramp, vertical green ramp. */
function gradient(w: number, h: number, alpha: boolean): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = Math.round((255 * x) / Math.max(1, w - 1));
      rgba[i + 1] = Math.round((255 * y) / Math.max(1, h - 1));
      rgba[i + 2] = (x * 7 + y * 13) % 256;
      rgba[i + 3] = alpha ? ((x + y) % 2 ? 255 : 64) : 255;
    }
  }
  return rgba;
}

describe('rgbaToThumbHash (vendored reference encoder)', () => {
  // Vectors produced by the reference thumbhash@0.1.1 rgbaToThumbHash, which
  // clients use to decode. The port must match it byte for byte.
  it.each([
    [100, 50, false, '4AcKNJqAh3dwd3d4eHdwgAf4eA=='],
    [37, 91, false, 'IPgJOxpwcHd4d4d3gIAI94g='],
    [64, 64, true, '4PeFJRAJcIZweHd3d4CACPd4eHgHB4eIcA==']
  ])('matches the reference for %ix%i (alpha %s)', (w, h, alpha, expected) => {
    expect(
      Buffer.from(rgbaToThumbHash(w, h, gradient(w, h, alpha))).toString(
        'base64'
      )
    ).toBe(expected);
  });

  it('refuses images above 100 pixels a side', () => {
    expect(() =>
      rgbaToThumbHash(101, 10, new Uint8Array(101 * 10 * 4))
    ).toThrow("doesn't fit");
  });
});

function solid(
  width: number,
  height: number,
  color: { r: number; g: number; b: number }
) {
  return Sharp({
    create: { width, height, channels: 3, background: color }
  });
}

describe('orientedSize', () => {
  it('swaps sides only for the rotated EXIF orientations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20_000 }),
        fc.integer({ min: 1, max: 20_000 }),
        fc.integer({ min: 1, max: 8 }),
        (width, height, orientation) => {
          const size = orientedSize({ width, height, orientation });
          expect(size).toEqual(
            orientation >= 5
              ? { width: height, height: width }
              : { width, height }
          );
        }
      )
    );
  });

  it('reports one frame of a multi-frame image', () => {
    expect(
      orientedSize({ width: 40, height: 120, pageHeight: 30, pages: 4 })
    ).toEqual({ width: 40, height: 30 });
  });

  it('is unknown without positive dimensions', () => {
    expect(orientedSize({})).toBeNull();
    expect(orientedSize({ width: 0, height: 10 })).toBeNull();
  });
});

describe('describeImage', () => {
  it('reports the size and a ThumbHash with the right shape', async () => {
    const png = await solid(300, 150, { r: 255, g: 0, b: 0 }).png().toBuffer();

    const hints = await describeImage(png);

    expect(hints).toMatchObject({ width: 300, height: 150 });
    expect(hints!.thumbhash.length).toBeLessThanOrEqual(64);
    const header = thumbHashHeader(hints!.thumbhash);
    expect(header.aspectRatio).toBeCloseTo(7 / 4, 1);
    expect(header.hasAlpha).toBe(false);
  });

  it('reports the displayed size of an EXIF-rotated JPEG', async () => {
    const jpeg = await solid(300, 150, { r: 0, g: 0, b: 255 })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const hints = await describeImage(jpeg);

    expect(hints).toMatchObject({ width: 150, height: 300 });
    expect(thumbHashHeader(hints!.thumbhash).aspectRatio).toBeCloseTo(4 / 7, 1);
  });

  it('describes images smaller than the ThumbHash limit', async () => {
    const tiny = await solid(3, 2, { r: 0, g: 255, b: 0 }).png().toBuffer();

    await expect(describeImage(tiny)).resolves.toMatchObject({
      width: 3,
      height: 2
    });
  });

  it('describes one frame of a GIF fixture', async () => {
    const gif = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../../scripts/media-fixtures/gif')
    ) as Buffer;
    const metadata = await Sharp(gif, { animated: true }).metadata();

    const hints = await describeImage(gif);

    expect(hints).toMatchObject({
      width: metadata.width,
      height: metadata.pageHeight ?? metadata.height
    });
  });
});
