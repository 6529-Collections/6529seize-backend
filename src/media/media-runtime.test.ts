import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { resizeImageBufferToHeight } from '@/media/image-resize';
import { dropMediaSanitizerService } from '@/drops/drop-media-sanitizer.service';

const imagescript = require('imagescript');

const fixture = (format: string) =>
  readFileSync(join(__dirname, '../../scripts/media-fixtures', format));

describe('media dependency compatibility with real codecs', () => {
  it.each(['jpeg', 'png', 'webp', 'tiff', 'avif', 'svg', 'gif'])(
    'converts %s through the shared WebP resize helper',
    async (format) => {
      const output = await resizeImageBufferToHeight({
        buffer: fixture(format),
        height: 6,
        toWebp: true
      });
      expect(await sharp(output).metadata()).toMatchObject({
        format: 'webp',
        height: 6
      });
    }
  );

  it('preserves GIF frames and timing through ImageScript', async () => {
    const output = await resizeImageBufferToHeight({
      buffer: fixture('gif'),
      height: 6,
      toWebp: false
    });
    expect(await sharp(output, { animated: true }).metadata()).toMatchObject({
      pages: 2,
      pageHeight: 6,
      delay: [80, 160]
    });
  });

  it('preserves GIF frames and timing when the shared helper falls back to Sharp', async () => {
    const decode = jest
      .spyOn(imagescript.GIF, 'decode')
      .mockRejectedValueOnce(new Error('fallback fixture'));
    try {
      const output = await resizeImageBufferToHeight({
        buffer: fixture('gif'),
        height: 6,
        toWebp: false
      });
      expect(await sharp(output, { animated: true }).metadata()).toMatchObject({
        pages: 2,
        pageHeight: 6,
        delay: [80, 160],
        loop: 2
      });
    } finally {
      decode.mockRestore();
    }
  });

  it.each(['jpeg', 'png', 'webp', 'gif'])(
    'sanitizes real %s data without changing its format',
    async (format) => {
      const { buffer, contentType } =
        await dropMediaSanitizerService.sanitizeBuffer({
          input: fixture(format),
          declaredMimeType: `image/${format}`
        });
      expect(contentType).toBe(`image/${format}`);
      const meta = await sharp(buffer, { animated: true }).metadata();
      expect(meta.format).toBe(format);
      for (const field of ['exif', 'xmp', 'icc', 'orientation'] as const) {
        expect(meta[field]).toBeUndefined();
      }
      if (format === 'jpeg') {
        expect(meta).toMatchObject({ width: 12, height: 24 });
      }
      if (format === 'gif') {
        expect(meta).toMatchObject({ pages: 2, delay: [80, 160], loop: 2 });
      }
    }
  );

  it('rejects corrupt images and MIME mismatches', async () => {
    await expect(
      dropMediaSanitizerService.sanitizeBuffer({
        input: Buffer.from('not an image'),
        declaredMimeType: 'image/png'
      })
    ).rejects.toThrow();
    await expect(
      dropMediaSanitizerService.sanitizeBuffer({
        input: fixture('png'),
        declaredMimeType: 'image/jpeg'
      })
    ).rejects.toThrow('does not match');
  });
});
