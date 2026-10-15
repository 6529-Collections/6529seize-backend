import sharp from 'sharp';
import { resizeImageBufferToHeight } from '@/media/image-resize';

jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: jest.fn() }) }
}));

function solidImage(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: '#c03030' }
  });
}

async function dimensions(buffer: Buffer) {
  const metadata = await sharp(buffer, { animated: true }).metadata();
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.pageHeight ?? metadata.height
  };
}

describe('resizeImageBufferToHeight with real codecs', () => {
  it.each([208, 450, 1000])(
    'keeps the original bytes of a 320x208 GIF for target height %s',
    async (target) => {
      const original = await solidImage(320, 208).gif().toBuffer();
      const result = await resizeImageBufferToHeight({
        buffer: original,
        height: target,
        toWebp: false
      });
      expect(result.equals(original)).toBe(true);
    }
  );

  it('converts a source labelled GIF that is really another format', async () => {
    const png = await solidImage(320, 208).png().toBuffer();
    const result = await resizeImageBufferToHeight({
      buffer: png,
      height: 450,
      toWebp: false
    });
    expect(result.equals(png)).toBe(false);
    await expect(dimensions(result)).resolves.toMatchObject({
      format: 'gif',
      height: 208
    });
  });

  it('still shrinks a GIF taller than the target', async () => {
    const original = await solidImage(320, 208).gif().toBuffer();
    const result = await resizeImageBufferToHeight({
      buffer: original,
      height: 60,
      toWebp: false
    });
    await expect(dimensions(result)).resolves.toMatchObject({
      format: 'gif',
      height: 60
    });
  });

  it('encodes a short still image as WebP at its own size', async () => {
    const original = await solidImage(320, 208).png().toBuffer();
    const result = await resizeImageBufferToHeight({
      buffer: original,
      height: 1000,
      toWebp: true
    });
    await expect(dimensions(result)).resolves.toEqual({
      format: 'webp',
      width: 320,
      height: 208
    });
  });

  it('still scales a tall still image down to the target height', async () => {
    const original = await solidImage(400, 1600).png().toBuffer();
    const result = await resizeImageBufferToHeight({
      buffer: original,
      height: 450,
      toWebp: true
    });
    await expect(dimensions(result)).resolves.toMatchObject({
      format: 'webp',
      height: 450
    });
  });
});
