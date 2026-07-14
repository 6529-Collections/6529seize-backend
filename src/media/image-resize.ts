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

  if (toWebp) {
    return await sharp(buffer).resize({ height }).webp().toBuffer();
  }

  try {
    const gif = await imagescript.GIF.decode(buffer);
    const scaleFactor = gif.height / height;
    gif.resize(gif.width / scaleFactor, height);
    return gif.encode();
  } catch (error) {
    logger.warn(
      `[GIF RESIZE FALLBACK] ImageScript failed; retrying with Sharp [height=${height}]`,
      error
    );
    return await sharp(buffer, { animated: true })
      .resize({ height })
      .gif()
      .toBuffer();
  }
}
