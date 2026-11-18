import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sharp from 'sharp';
import {
  prepareUploadImagePreviews,
  PREVIEW_TIMEOUT_MESSAGE,
  UploadPreviewTimeoutError
} from '@/media/upload-image-previews';
import * as resizeSafety from '@/mediaResizerLoop/resize-resource-safety';

// Different frame colours, transparency, timing and a finite loop exercise more
// than a still image with an animated file extension.
async function animatedGif(frameHeight: number): Promise<Buffer> {
  const width = 32;
  const pixels = Buffer.alloc(width * frameHeight * 3 * 4);
  for (let frame = 0; frame < 3; frame++) {
    for (let y = 0; y < frameHeight; y++) {
      for (let x = 4; x < width - 4; x++) {
        const offset = ((frame * frameHeight + y) * width + x) * 4;
        pixels[offset + frame] = 255;
        pixels[offset + 3] = 255;
      }
    }
  }
  return Sharp(pixels, {
    raw: {
      width,
      height: frameHeight * 3,
      channels: 4,
      pageHeight: frameHeight
    }
  })
    .gif({ delay: [120, 240, 360], loop: 3 })
    .toBuffer();
}

// The independent encoder path is the compatibility contract: reusing a
// preview must produce exactly the bytes each independent encode would have
// produced. GIF previews use libimagequant's fastest effort (see
// upload-image-previews-large-images.test.ts for why).
function independentPreview(source: string, height: number, animated = true) {
  return Sharp(source, {
    failOn: 'error',
    animated,
    limitInputPixels: 1_000_000_000
  })
    .resize(null, height, {
      withoutEnlargement: true,
      fit: 'cover',
      fastShrinkOnLoad: true
    })
    .rotate()
    .gif({ effort: 1 })
    .toBuffer();
}

describe('upload image previews', () => {
  let directory: string;
  let source: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'upload-previews-'));
    source = join(directory, 'source');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([200, 450])(
    'encodes a %i-pixel-high GIF once without changing either preview',
    async (frameHeight) => {
      await writeFile(source, await animatedGif(frameHeight));
      // Sharp stacks frames in height; eligibility must use pageHeight.
      expect(await Sharp(source, { animated: true }).metadata()).toMatchObject({
        height: frameHeight * 3,
        pageHeight: frameHeight
      });
      const previews = await prepareUploadImagePreviews(source, 'image/gif');

      expect(previews.map(({ option }) => option)).toEqual([
        'AUTOx450',
        'AUTOx1080'
      ]);
      expect(previews[1].path).toBe(previews[0].path);
      expect(previews[0].path).not.toBe(source);
      for (const [index, height] of [
        [0, 450],
        [1, 1080]
      ]) {
        const output = await readFile(previews[index].path);
        expect(output).toEqual(await independentPreview(source, height));
        expect(
          await Sharp(output, { animated: true }).metadata()
        ).toMatchObject({
          format: 'gif',
          width: 32,
          pageHeight: frameHeight,
          pages: 3,
          delay: [120, 240, 360],
          loop: 3,
          hasAlpha: true
        });
      }
    }
  );

  it('keeps independently resized previews above the 450-pixel boundary', async () => {
    await writeFile(source, await animatedGif(451));
    const previews = await prepareUploadImagePreviews(source, 'image/gif');
    expect(previews[1].path).not.toBe(previews[0].path);
    for (const [index, height] of [
      [0, 450],
      [1, 1080]
    ]) {
      expect(await readFile(previews[index].path)).toEqual(
        await independentPreview(source, height)
      );
    }
  });

  it('preserves the resource-limited still-preview fallback', async () => {
    await writeFile(source, await animatedGif(200));
    const inspect = resizeSafety.inspectResizeInput;
    jest
      .spyOn(resizeSafety, 'inspectResizeInput')
      .mockImplementation(async (...args) => ({
        ...(await inspect(...args)),
        resizeAnimated: false
      }));
    const previews = await prepareUploadImagePreviews(source, 'image/gif');
    expect(previews[1].path).not.toBe(previews[0].path);
    for (const [index, height] of [
      [0, 450],
      [1, 1080]
    ]) {
      expect(await readFile(previews[index].path)).toEqual(
        await independentPreview(source, height, false)
      );
    }
  });

  it('reports a native timeout as a retryable, readable preview failure', async () => {
    await writeFile(source, await animatedGif(451));
    const native =
      'timeout: 0% complete\nVipsImage: killed for image "temp-408"\nwbuffer_write: write failed';
    jest
      .spyOn(Sharp.prototype, 'toFile')
      .mockRejectedValueOnce(new Error(native));
    const failure = await prepareUploadImagePreviews(source, 'image/gif').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(UploadPreviewTimeoutError);
    expect(failure).toMatchObject({
      message: PREVIEW_TIMEOUT_MESSAGE,
      nativeMessage: native
    });
    // Timeouts stay operational: the sanitizer retries them before failing.
    expect(resizeSafety.isUnprocessableResizeInput(failure)).toBe(false);
  });

  it('propagates other native failures unchanged', async () => {
    await writeFile(source, await animatedGif(451));
    const native = new Error('gifsave: write failed');
    jest.spyOn(Sharp.prototype, 'toFile').mockRejectedValueOnce(native);
    await expect(prepareUploadImagePreviews(source, 'image/gif')).rejects.toBe(
      native
    );
  });

  it('rejects truncated GIF pixels even when the small-image metadata can be read', async () => {
    const valid = await animatedGif(200);
    await writeFile(source, valid.subarray(0, Math.floor(valid.length / 2)));
    await expect(
      Sharp(source, { failOn: 'none', animated: true }).metadata()
    ).resolves.toMatchObject({ format: 'gif', width: 32 });
    await expect(
      prepareUploadImagePreviews(source, 'image/gif')
    ).rejects.toThrow();
  });
});
