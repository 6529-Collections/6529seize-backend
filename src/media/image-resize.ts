import sharp from 'sharp';
import { Logger } from '@/logging';

const imagescript = require('imagescript');
const logger = Logger.get('IMAGE_RESIZE');

export async function resizeImageBufferToHeight({
  buffer,
  height,
  toWebp
}: {
  buffer: Buffer;
  height: number;
  toWebp: boolean;
}): Promise<Buffer> {
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`Invalid resize height: ${height}`);
  }

  // Derivatives never enlarge: an upscaled, re-encoded copy only adds bytes.
  if (toWebp) {
    return await sharp(buffer)
      .resize({ height, withoutEnlargement: true })
      .webp()
      .toBuffer();
  }

  try {
    const gif = await imagescript.GIF.decode(buffer);
    if (gif.height <= height) {
      // The original GIF already fits; re-encoding it would not shrink it.
      return buffer;
    }
    const scaleFactor = gif.height / height;
    gif.resize(gif.width / scaleFactor, height);
    return gif.encode();
  } catch (error) {
    logger.warn(
      `[GIF RESIZE FALLBACK] ImageScript failed; retrying with Sharp [height=${height}]`,
      error
    );
    const animated = sharp(buffer, { animated: true });
    const metadata = await animated.metadata();
    const frameHeight = metadata.pageHeight ?? metadata.height;
    if (frameHeight !== undefined && frameHeight <= height) {
      return buffer;
    }
    return await animated
      .resize({ height, withoutEnlargement: true })
      .gif()
      .toBuffer();
  }
}
