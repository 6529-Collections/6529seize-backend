import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Sharp from 'sharp';
import {
  getGifPreviewDimensions,
  prepareGifPreview,
  validateGifTiming
} from './gif-preview';
import { withResizeSourceFile } from './resize-resource-safety';

let directory: string;
let source: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gif-preview-test-'));
  source = join(directory, 'source');
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

async function fixture(width: number, height: number, pages: number) {
  const pixels = Buffer.alloc(width * height * pages * 4);
  for (let page = 0; page < pages; page++) {
    // Transparent areas and distinct frames exercise coalescing and alpha.
    for (let p = 0; p < width * height; p++) {
      const offset = (page * width * height + p) * 4;
      pixels[offset + (page % 3)] = 100 + (page % 155);
      pixels[offset + 3] = p % 3 === 0 ? 0 : 255;
    }
  }
  const bytes = await Sharp(pixels, {
    raw: { width, height: height * pages, channels: 4, pageHeight: height }
  })
    .gif({
      delay: Array.from({ length: pages }, (_, p) => 40 + p * 10),
      loop: 3
    })
    .toBuffer();
  await writeFile(source, bytes);
  return bytes;
}

it('preserves every frame, timing, loop and alpha while resizing', async () => {
  await fixture(20, 14, 3);
  const output = await prepareGifPreview(source, {
    width: null,
    height: 7,
    fit: 'cover'
  });
  expect(await Sharp(output, { animated: true }).metadata()).toMatchObject({
    width: 10,
    pageHeight: 7,
    pages: 3,
    delay: [40, 50, 60],
    loop: 3,
    hasAlpha: true
  });
  for (let page = 0; page < 3; page++) {
    const expected = await Sharp(source, { page, pages: 1 })
      .resize({ height: 7 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const actual = await Sharp(output, { page, pages: 1 })
      .ensureAlpha()
      .raw()
      .toBuffer();
    // Palette quantization can perturb RGB slightly; opaque color must survive.
    expect(actual.length).toBe(expected.length);
    expect(actual[4 + page]).toBeGreaterThan(80);
  }
});

it('keeps an already-small original byte-for-byte instead of re-encoding it', async () => {
  const bytes = await fixture(20, 14, 3);
  const output = await prepareGifPreview(source, {
    width: null,
    height: 800,
    fit: 'cover'
  });
  expect(output).toBe(source);
  expect(await readFile(output)).toEqual(bytes);
});

it('resizes recoverable GIF data accepted by the legacy decoder', async () => {
  const bytes = await readFile(
    join(__dirname, '../../scripts/media-fixtures/gif')
  );
  // One complete frame followed by a truncated extension. Strict loading
  // rejects the header, but the legacy tolerant decoder recovers that frame.
  await writeFile(source, bytes.subarray(0, 73));
  await expect(Sharp(source).metadata()).rejects.toThrow();
  const legacy = Sharp(source, { failOn: 'none', animated: true });
  const metadata = await legacy.metadata();
  const expected = await legacy
    .resize({ height: 6 })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const output = await prepareGifPreview(source, {
    width: null,
    height: 6,
    fit: 'cover'
  });
  expect(await Sharp(output, { animated: true }).metadata()).toMatchObject({
    height: 6,
    pages: metadata.pages,
    delay: metadata.delay,
    loop: metadata.loop
  });
  expect(await Sharp(output).ensureAlpha().raw().toBuffer()).toEqual(expected);
});

it('preserves an animation above the old full-source budget within a smaller output budget', async () => {
  await fixture(1024, 1024, 33);
  const output = await prepareGifPreview(source, {
    width: null,
    height: 100,
    fit: 'cover'
  });
  expect(await Sharp(output, { animated: true }).metadata()).toMatchObject({
    width: 100,
    pageHeight: 100,
    pages: 33,
    loop: 3
  });
}, 60000);

it('rejects excessive frame counts instead of publishing a still as an animation', async () => {
  await fixture(2, 2, 121);
  await expect(
    prepareGifPreview(source, { width: null, height: 1, fit: 'cover' })
  ).rejects.toThrow('DECODED_IMAGE_TOO_LARGE');
});

it('does not accept a non-GIF under the animation contract', async () => {
  await Sharp({
    create: { width: 2, height: 2, channels: 3, background: 'red' }
  })
    .png()
    .toFile(source);
  await expect(
    prepareGifPreview(source, { width: null, height: 1, fit: 'cover' })
  ).rejects.toThrow('INVALID_IMAGE');
});

it('cleans source and animation scratch files after callback failure', async () => {
  const bytes = await fixture(20, 14, 3);
  let temporaryDirectory = '';
  await expect(
    withResizeSourceFile(
      Readable.from([bytes]),
      bytes.length,
      async (inputPath) => {
        temporaryDirectory = inputPath.slice(0, inputPath.lastIndexOf('/'));
        await prepareGifPreview(inputPath, {
          width: null,
          height: 7,
          fit: 'cover'
        });
        throw new Error('upload failed');
      }
    )
  ).rejects.toThrow('upload failed');
  await expect(readdir(temporaryDirectory)).rejects.toMatchObject({
    code: 'ENOENT'
  });
});

it.each([
  [800, 800, 120],
  [8_000_000, 1, 120],
  [1, 8_000_000, 120]
])(
  'bounds total output pixels for %s by %s with %s frames',
  (width, height, pages) => {
    const output = getGifPreviewDimensions(width, height, pages);
    expect(output.width).toBeGreaterThanOrEqual(1);
    expect(output.height).toBeGreaterThanOrEqual(1);
    expect(output.width * output.height * pages).toBeLessThanOrEqual(
      8 * 1024 * 1024
    );
  }
);

it('honors the deadline without publishing a partial animation', async () => {
  await fixture(20, 14, 3);
  const clock = jest
    .spyOn(Date, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValue(21_000);
  try {
    await expect(
      prepareGifPreview(source, { width: null, height: 7, fit: 'cover' })
    ).rejects.toThrow('GIF_PREVIEW_DEADLINE_EXCEEDED');
  } finally {
    clock.mockRestore();
  }
});

it.each([[40], [40, -1], [40, 0.5], [40, 655360]])(
  'rejects inconsistent or invalid animation delays %j',
  (...delay) => {
    expect(() => validateGifTiming({ delay }, 2)).toThrow('INVALID_IMAGE');
  }
);

it('allows zero delay and a single image without animation metadata', () => {
  expect(() => validateGifTiming({ delay: [0, 100] }, 2)).not.toThrow();
  expect(() => validateGifTiming({}, 1)).not.toThrow();
  expect(() => validateGifTiming({}, 2)).toThrow('INVALID_IMAGE');
});

it('leaves processing retryable when Lambda time is needed for upload and cleanup', async () => {
  await fixture(20, 14, 3);
  await expect(
    prepareGifPreview(source, { width: null, height: 7, fit: 'cover' }, 2500)
  ).rejects.toThrow('GIF_PREVIEW_DEADLINE_EXCEEDED');
});

it('reads complete GIF metadata without decoding the full animation', async () => {
  await fixture(20, 14, 3);
  const selected = await Sharp(source).metadata();
  const animated = await Sharp(source, { animated: true }).metadata();
  expect(selected.pages).toBe(animated.pages);
  expect(selected.delay).toEqual(animated.delay);
  expect(selected.loop).toBe(animated.loop);
});
