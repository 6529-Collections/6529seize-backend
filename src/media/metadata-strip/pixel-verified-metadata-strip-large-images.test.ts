import Sharp from 'sharp';
import {
  GIF_FRAME_SIDE,
  gifColorTableBytes,
  largeGif,
  largeJpeg,
  largePalettePng,
  largeRgbaPng,
  PaletteColour,
  pngPaletteChunk
} from './fixtures/large-image-fixtures';
import * as lossless from './lossless-metadata-strip';
import { stripMetadataWithPixelCheck } from './pixel-verified-metadata-strip';

/**
 * Images above the old 128 MiB decoded-pixel budget, which the pixel check
 * used to give up on. Each must verify losslessly in a fraction of its
 * decoded size, and a change confined to the last band must still be caught.
 * The memory threshold is half the decoded size: the old check held at least
 * all of it (measured: 1,226 MiB for the JPEG with its rotation copy), the
 * banded check holds one 64 MiB band plus libvips's working set (measured:
 * 66-90 MiB for these fixtures).
 */

const JPEG_SIDE = 12_000;
const GIF_FRAMES = 900;
const PALETTE: readonly PaletteColour[] = [
  [200, 30, 30],
  [30, 200, 30],
  [30, 30, 200],
  [240, 240, 0]
];

/** Offsets of every Graphic Control Extension, walking the GIF blocks. */
function graphicControlOffsets(gif: Buffer): number[] {
  const skipSubBlocks = (from: number) => {
    let position = from;
    while (gif[position] !== 0) position += gif[position] + 1;
    return position + 1;
  };
  const offsets: number[] = [];
  let position = 13 + gifColorTableBytes(gif[10]);
  while (gif[position] !== 0x3b) {
    if (gif[position] === 0x21) {
      if (gif[position + 1] === 0xf9) offsets.push(position);
      position = skipSubBlocks(position + 2);
    } else if (gif[position] === 0x2c) {
      position += 10 + gifColorTableBytes(gif[position + 9]);
      position = skipSubBlocks(position + 1);
    } else {
      throw new Error(`Unexpected GIF block at ${position}`);
    }
  }
  return offsets;
}

/** Flips a scan byte about 2 KB before EOI: only the bottom rows change. */
function withTamperedTail(jpeg: Buffer): Buffer {
  const tampered = Buffer.from(jpeg);
  let index = tampered.lastIndexOf(Buffer.from([0xff, 0xd9])) - 2000;
  while (tampered[index] === 0xff || tampered[index - 1] === 0xff) index++;
  tampered[index] ^= tampered[index] === 0xaa ? 0x0f : 0x55;
  return tampered;
}

/** Peak growth of this process's resident set while `work` runs. */
async function peakRssGrowth<T>(
  work: () => Promise<T>
): Promise<{ result: T; growth: number }> {
  const baseline = process.memoryUsage.rss();
  let peak = baseline;
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage.rss());
  };
  const timer = setInterval(sample, 5);
  try {
    const result = await work();
    sample();
    return { result, growth: peak - baseline };
  } finally {
    clearInterval(timer);
  }
}

function expectNoIdentifyingText(image: Buffer) {
  const text = image.toString('latin1');
  for (const value of ['SynthCam', 'Jane Synthetic']) {
    expect(text).not.toContain(value);
  }
}

/** Bypasses the structural proof so only the pixel check stands guard. */
function mockStripOutput(
  input: Buffer,
  format: lossless.LosslessStripFormat,
  output: Buffer
) {
  jest.spyOn(lossless, 'stripMetadataLosslessly').mockReturnValue({
    output,
    input: lossless.describeImageContainer(input, format)
  });
}

describe('stripMetadataWithPixelCheck: images above the old decoded budget', () => {
  let concurrency: number;

  beforeAll(() => {
    // The 2 GiB sanitizer Lambda has two vCPUs, so libvips runs two threads.
    concurrency = Sharp.concurrency();
    Sharp.concurrency(2);
  });

  afterAll(() => {
    Sharp.concurrency(concurrency);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('JPEG, 12000 x 12000', () => {
    let jpeg: Buffer;

    beforeAll(async () => {
      jpeg = await largeJpeg(JPEG_SIDE);
    }, 60_000);

    it('verifies losslessly in a fraction of the decoded size', async () => {
      const { result, growth } = await peakRssGrowth(() =>
        stripMetadataWithPixelCheck(jpeg, 'jpeg')
      );
      expect(result.kind).toBe('lossless');
      if (result.kind !== 'lossless') return;
      expect(result.buffer).toEqual(
        lossless.stripMetadataLosslessly(jpeg, 'jpeg').output
      );
      expectNoIdentifyingText(result.buffer);
      expect(await Sharp(result.buffer).metadata()).toMatchObject({
        width: JPEG_SIDE,
        height: JPEG_SIDE,
        orientation: 6
      });
      expect(growth).toBeLessThan((JPEG_SIDE * JPEG_SIDE * 3) / 2);
    }, 180_000);

    it('catches scan data changed in the last band', async () => {
      const output = lossless.stripMetadataLosslessly(jpeg, 'jpeg').output;
      mockStripOutput(jpeg, 'jpeg', withTamperedTail(output));
      await expect(stripMetadataWithPixelCheck(jpeg, 'jpeg')).resolves.toEqual({
        kind: 'unverified',
        reason: 'Decoded digest changed after stripping'
      });
    }, 180_000);
  });

  it('verifies a 10000 x 8000 RGBA PNG in a fraction of the decoded size', async () => {
    const png = await largeRgbaPng(10_000, 8_000);
    const { result, growth } = await peakRssGrowth(() =>
      stripMetadataWithPixelCheck(png, 'png')
    );
    expect(result).toEqual({
      kind: 'lossless',
      buffer: lossless.stripMetadataLosslessly(png, 'png').output,
      removed: ['tEXt']
    });
    expect(growth).toBeLessThan((10_000 * 8_000 * 4) / 2);
  }, 120_000);

  it('verifies a large palette PNG and catches a changed palette entry', async () => {
    const png = largePalettePng(10_000, 8_000, PALETTE);
    const stripped = await stripMetadataWithPixelCheck(png, 'png');
    expect(stripped).toMatchObject({ kind: 'lossless', removed: ['tEXt'] });
    if (stripped.kind !== 'lossless') return;
    const original = pngPaletteChunk(PALETTE);
    const changed = pngPaletteChunk([...PALETTE.slice(0, 3), [0, 240, 240]]);
    const at = stripped.buffer.indexOf(original);
    expect(at).toBeGreaterThan(0);
    mockStripOutput(
      png,
      'png',
      Buffer.concat([
        stripped.buffer.subarray(0, at),
        changed,
        stripped.buffer.subarray(at + original.length)
      ])
    );
    await expect(stripMetadataWithPixelCheck(png, 'png')).resolves.toEqual({
      kind: 'unverified',
      reason: 'Decoded digest changed after stripping'
    });
  }, 120_000);

  describe('animated GIF, 900 frames', () => {
    let gif: Buffer;

    beforeAll(async () => {
      gif = await largeGif(GIF_FRAMES);
    }, 60_000);

    it('verifies every frame losslessly in a fraction of the decoded size', async () => {
      const { result, growth } = await peakRssGrowth(() =>
        stripMetadataWithPixelCheck(gif, 'gif')
      );
      expect(result).toMatchObject({ kind: 'lossless' });
      if (result.kind !== 'lossless') return;
      expectNoIdentifyingText(result.buffer);
      expect(
        await Sharp(result.buffer, { animated: true }).metadata()
      ).toMatchObject({ pages: GIF_FRAMES, pageHeight: GIF_FRAME_SIDE });
      expect(growth).toBeLessThan(
        (GIF_FRAME_SIDE * GIF_FRAME_SIDE * 4 * GIF_FRAMES) / 2
      );
    }, 120_000);

    it('catches a changed last frame', async () => {
      mockStripOutput(
        gif,
        'gif',
        await largeGif(GIF_FRAMES, { r: 0, g: 0, b: 0 })
      );
      await expect(stripMetadataWithPixelCheck(gif, 'gif')).resolves.toEqual({
        kind: 'unverified',
        reason: 'Decoded digest changed after stripping'
      });
    }, 120_000);

    it('catches a changed frame delay', async () => {
      const output = Buffer.from(
        lossless.stripMetadataLosslessly(gif, 'gif').output
      );
      const offsets = graphicControlOffsets(output);
      expect(offsets).toHaveLength(GIF_FRAMES);
      output.writeUInt16LE(7, offsets[GIF_FRAMES - 1] + 4);
      mockStripOutput(gif, 'gif', output);
      await expect(stripMetadataWithPixelCheck(gif, 'gif')).resolves.toEqual({
        kind: 'unverified',
        reason: 'Decoded delay changed after stripping'
      });
    }, 120_000);
  });
});
