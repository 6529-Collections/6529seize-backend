import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Sharp, { Metadata } from 'sharp';
import {
  assertPngPreviewInput,
  boundPngPreview,
  PNG_PREVIEW_LIMITS
} from '@/media/png-preview-policy';
import { preparePngPreview, sanitizePngFile } from '@/media/png-preview';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'png-preview-test-'));
  // ts-jest's compiler/DB module graph is not deployed in the media Lambda.
  // Keep the real child RSS; model only the deployed parent's small baseline.
  const original = process.memoryUsage;
  jest.spyOn(process, 'memoryUsage').mockImplementation(
    Object.assign(() => ({ ...original(), rss: 64 * 1024 * 1024 }), {
      rss: original.rss
    })
  );
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function image(width: number, height: number, interlaced = false) {
  const source = join(directory, 'source.png');
  await Sharp({
    create: { width, height, channels: 4, background: '#33669980' }
  })
    .png({ progressive: interlaced })
    .toFile(source);
  return source;
}

it('admits the measured 64 MP RGBA input and rejects unmeasured boundaries', async () => {
  const metadata = await Sharp(await image(2, 2)).metadata();
  expect(() =>
    assertPngPreviewInput({ ...metadata, width: 8000, height: 8000 })
  ).not.toThrow();
  expect(() =>
    assertPngPreviewInput({ ...metadata, width: 10000, height: 10000 })
  ).not.toThrow();
  expect(() =>
    assertPngPreviewInput({ ...metadata, width: 10001, height: 10000 })
  ).toThrow('DECODED_IMAGE_TOO_LARGE');
  expect(() =>
    assertPngPreviewInput({
      ...metadata,
      depth: 'ushort',
      width: 8000,
      height: 8000
    })
  ).not.toThrow();
  expect(() =>
    assertPngPreviewInput({
      ...metadata,
      depth: 'ushort',
      width: 8001,
      height: 8000
    })
  ).toThrow('DECODED_IMAGE_TOO_LARGE');
  for (const invalid of [
    { width: 100001 },
    { width: NaN },
    { height: 0 },
    { channels: 5 },
    { depth: 'float' as const }
  ])
    expect(() =>
      assertPngPreviewInput({ ...metadata, ...invalid } as Metadata)
    ).toThrow();
});

it.each([false, true])(
  'resizes a real large PNG in isolation (interlaced: %s) and preserves alpha',
  async (interlaced) => {
    const source = await image(8000, 8000, interlaced);
    const original = await readFile(source);
    for (const height of [450, 1080]) {
      const output = await preparePngPreview(source, {
        width: null,
        height,
        fit: 'cover'
      });
      expect(await Sharp(output).metadata()).toMatchObject({
        width: height,
        height,
        hasAlpha: true,
        format: 'png'
      });
      const pixels = await Sharp(output).raw().toBuffer();
      expect(pixels[3]).toBeGreaterThan(0);
      expect(pixels[3]).toBeLessThan(255);
    }
    expect(await readFile(source)).toEqual(original);
  }
);

it('caps a very wide preview while preserving ordinary tall-image sizing', async () => {
  const wide = await image(100000, 100);
  const output = await preparePngPreview(wide, {
    width: null,
    height: 1080,
    fit: 'cover'
  });
  const metadata = await Sharp(output).metadata();
  expect(metadata.width!).toBeLessThanOrEqual(4096);
  expect(metadata.width! * metadata.height!).toBeLessThanOrEqual(2_000_000);
  expect((await readFile(output)).length).toBeLessThanOrEqual(
    PNG_PREVIEW_LIMITS.outputBytes
  );
  expect(
    boundPngPreview(
      { ...metadata, width: 100, height: 100000 },
      { width: null, height: 1080, fit: 'cover' },
      PNG_PREVIEW_LIMITS
    )
  ).toEqual({ width: null, height: 1080, fit: 'cover' });
});

it('preserves ordinary fit and EXIF orientation behavior byte-for-byte', async () => {
  const source = await image(40, 20);
  await Sharp(source)
    .withMetadata({ orientation: 6 })
    .toFile(join(directory, 'rotated.png'));
  const input = join(directory, 'rotated.png');
  for (const fit of ['cover', 'inside', 'outside'] as const) {
    const target = { width: 6, height: 8, fit };
    const expected = await Sharp(input, { failOn: 'error' })
      .resize(6, 8, { fit, withoutEnlargement: true })
      .rotate()
      .png()
      .toBuffer();
    const output = await preparePngPreview(input, target);
    expect(await readFile(output)).toEqual(expected);
  }
});

it('strips original PNG metadata without shrinking it', async () => {
  const source = join(directory, 'metadata.png');
  await Sharp(await image(40, 20))
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'Synthetic' } } })
    .toFile(source);
  const output = await sanitizePngFile(source);
  expect(await Sharp(output).metadata()).toMatchObject({
    width: 20,
    height: 40
  });
  expect((await Sharp(output).metadata()).exif).toBeUndefined();
});

it('keeps deadline and memory exhaustion operational and removes partial output', async () => {
  const source = await image(20, 20);
  const target = { width: null, height: 10, fit: 'cover' as const };
  await expect(preparePngPreview(source, target, 2000)).rejects.toThrow(
    'PNG_PREVIEW_DEADLINE_EXCEEDED'
  );
  jest.mocked(process.memoryUsage).mockReturnValue({
    ...process.memoryUsage(),
    rss: 2 * 1024 * 1024 * 1024
  });
  await expect(preparePngPreview(source, target)).rejects.toThrow(
    'PNG_PREVIEW_MEMORY_BUDGET_EXCEEDED'
  );
  expect(await readdir(directory)).toEqual(['source.png']);
});

it('rejects corrupt PNG pixel data without returning a preview', async () => {
  const source = await image(100, 100);
  const bytes = await readFile(source);
  await writeFile(source, bytes.subarray(0, Math.floor(bytes.length / 2)));
  await expect(
    preparePngPreview(source, { width: null, height: 50, fit: 'cover' })
  ).rejects.toThrow('INVALID_IMAGE');
  expect(await readdir(directory)).toEqual(['source.png']);
});
