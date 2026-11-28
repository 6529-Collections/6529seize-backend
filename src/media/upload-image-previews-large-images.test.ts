import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sharp from 'sharp';
import {
  prepareUploadImagePreviews,
  PREVIEW_TIMEOUT_SECONDS
} from '@/media/upload-image-previews';
import {
  MAX_DECODED_WORK_BYTES,
  UnprocessableResizeInput
} from '@/mediaResizerLoop/resize-resource-safety';

/**
 * Inputs at the sizes the sanitizer Lambda (two vCPUs) previews. The GIF is
 * the shape that timed out in production: a 400 x 560 animation of 128
 * dithered frames, each with its own palette, as video-to-GIF converters
 * write them. Resizing it for the 450 px preview blends the dither into
 * thousands of colours per frame, and with no shared palette to reuse the
 * encoder builds a new one for every frame. At Sharp's default effort that
 * took 70 s on a current Xeon core against the old 30 s timeout (production
 * logged `timeout: 0% complete`); at the preview effort it takes 9-12 s.
 *
 * The JPEGs pin the existing limits: the largest ones the previews admit
 * finish in well under a second, and anything beyond the decoded-work budget
 * is still rejected from its metadata, before any pixel is decoded. PNG
 * previews run in their own worker with its own deadline and parent-plus-child
 * RSS guard; png-preview.test.ts covers large PNGs in a fresh process.
 */

const PALETTE_STEPS = [6, 7, 6] as const;

/** One gradient, randomly dithered between neighbouring palette colours. */
function ditheredTexture(width: number, height: number): Buffer {
  const [reds, greens, blues] = PALETTE_STEPS;
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 1;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 16) / 65536;
  };
  const level = (value: number, steps: number) =>
    Math.round(
      (Math.min(steps - 1, Math.floor(value + random())) * 255) / (steps - 1)
    );
  for (let y = 0, offset = 0; y < height; y++) {
    for (let x = 0; x < width; x++, offset += 3) {
      const across = (x / width) * (reds - 1);
      const down = (y / height) * (greens - 1);
      pixels[offset] = level(across, reds);
      pixels[offset + 1] = level(down, greens);
      pixels[offset + 2] = level((across + down) / 2, blues);
    }
  }
  return pixels;
}

/** Frames scroll through the texture, so each one gets a palette of its own. */
async function ditheredAnimatedGif(
  width: number,
  height: number,
  frames: number
): Promise<Buffer> {
  const texture = ditheredTexture(width, height * 2);
  const row = width * 3;
  const pixels = Buffer.alloc(row * height * frames);
  for (let frame = 0; frame < frames; frame++) {
    const start = ((frame * 7) % height) * row;
    texture.copy(pixels, frame * height * row, start, start + height * row);
  }
  return Sharp(pixels, {
    raw: { width, height: height * frames, channels: 3, pageHeight: height }
  })
    .gif({ effort: 1, dither: 0, delay: Array(frames).fill(40), loop: 0 })
    .toBuffer();
}

/** Frames that carry a local colour table, walking the GIF blocks. */
function framesWithLocalPalettes(gif: Buffer): number {
  const tableBytes = (packed: number) =>
    packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0;
  const skipSubBlocks = (from: number) => {
    let position = from;
    while (gif[position] !== 0) position += gif[position] + 1;
    return position + 1;
  };
  let count = 0;
  let position = 13 + tableBytes(gif[10]);
  while (gif[position] !== 0x3b) {
    if (gif[position] === 0x21) {
      position = skipSubBlocks(position + 2);
    } else if (gif[position] === 0x2c) {
      if (gif[position + 9] & 0x80) count++;
      position += 10 + tableBytes(gif[position + 9]);
      position = skipSubBlocks(position + 1);
    } else {
      throw new Error(`Unexpected GIF block at ${position}`);
    }
  }
  return count;
}

async function syntheticJpeg(
  width: number,
  height: number,
  progressive: boolean
): Promise<Buffer> {
  return Sharp(ditheredTexture(512, 512), {
    raw: { width: 512, height: 512, channels: 3 }
  })
    .resize(width, height, { fit: 'fill' })
    .jpeg({ quality: 90, progressive })
    .toBuffer();
}

/** Peak growth of this process's resident set while `work` runs. */
async function measure<T>(
  work: () => Promise<T>
): Promise<{ result: T; growth: number; elapsedMs: number }> {
  const baseline = process.memoryUsage.rss();
  let peak = baseline;
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage.rss());
  };
  const timer = setInterval(sample, 5);
  const started = Date.now();
  try {
    const result = await work();
    sample();
    return { result, growth: peak - baseline, elapsedMs: Date.now() - started };
  } finally {
    clearInterval(timer);
  }
}

async function frameShape(path: string) {
  const { width, pageHeight, height, pages } = await Sharp(path, {
    animated: true
  }).metadata();
  return { width, height: pageHeight ?? height, pages: pages ?? 1 };
}

describe('upload image previews: large inputs', () => {
  let concurrency: number;
  let directory: string;
  let source: string;

  beforeAll(() => {
    // The 2 GiB sanitizer Lambda has two vCPUs, so libvips runs two threads.
    concurrency = Sharp.concurrency();
    Sharp.concurrency(2);
  });

  afterAll(() => {
    Sharp.concurrency(concurrency);
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'upload-previews-large-'));
    source = join(directory, 'source');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('previews every frame of a dithered 128-frame GIF with per-frame palettes', async () => {
    const gif = await ditheredAnimatedGif(400, 560, 128);
    // The production trigger: no shared palette the encoder could reuse.
    expect(framesWithLocalPalettes(gif)).toBeGreaterThan(120);
    await writeFile(source, gif);

    const { result, growth, elapsedMs } = await measure(() =>
      prepareUploadImagePreviews(source, 'image/gif')
    );

    expect(result.map(({ option }) => option)).toEqual([
      'AUTOx450',
      'AUTOx1080'
    ]);
    expect(await frameShape(result[0].path)).toEqual({
      width: 321,
      height: 450,
      pages: 128
    });
    expect(await frameShape(result[1].path)).toEqual({
      width: 400,
      height: 560,
      pages: 128
    });
    expect((await readFile(result[0].path)).length).toBeGreaterThan(0);
    // Each preview has its own timeout; together they must stay well inside.
    expect(elapsedMs).toBeLessThan(PREVIEW_TIMEOUT_SECONDS * 1000);
    expect(growth).toBeLessThan(MAX_DECODED_WORK_BYTES);
  }, 300_000);

  it('previews the largest progressive JPEG the budget admits', async () => {
    // Progressive JPEGs get no decoder shrink in admission: 16 bytes a pixel.
    const side = Math.floor(Math.sqrt(MAX_DECODED_WORK_BYTES / 16));
    await writeFile(source, await syntheticJpeg(side, side, true));
    const { result, growth } = await measure(() =>
      prepareUploadImagePreviews(source, 'image/jpeg')
    );
    expect(await frameShape(result[0].path)).toEqual({
      width: 450,
      height: 450,
      pages: 1
    });
    expect(await frameShape(result[1].path)).toEqual({
      width: 1080,
      height: 1080,
      pages: 1
    });
    expect(growth).toBeLessThan(MAX_DECODED_WORK_BYTES);
  }, 120_000);

  it('previews a 9000 x 9000 baseline JPEG through shrink-on-load', async () => {
    await writeFile(source, await syntheticJpeg(9000, 9000, false));
    const { result, growth } = await measure(() =>
      prepareUploadImagePreviews(source, 'image/jpeg')
    );
    expect(await frameShape(result[1].path)).toEqual({
      width: 1080,
      height: 1080,
      pages: 1
    });
    expect(growth).toBeLessThan(MAX_DECODED_WORK_BYTES);
  }, 120_000);

  it('still rejects a 9000 x 9000 progressive JPEG before decoding it', async () => {
    await writeFile(source, await syntheticJpeg(9000, 9000, true));
    const failure = await prepareUploadImagePreviews(source, 'image/jpeg').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(UnprocessableResizeInput);
    expect(failure).toMatchObject({ code: 'DECODED_IMAGE_TOO_LARGE' });
  }, 120_000);
});
