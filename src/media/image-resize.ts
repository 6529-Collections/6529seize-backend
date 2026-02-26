import sharp from 'sharp';

const imagescript = require('imagescript');

export async function resizeImageBufferToHeight({
  buffer,
  height,
  toWebp
}: {
  buffer: Buffer;
  height: number;
  toWebp: boolean;
}): Promise<Buffer> {
  if (toWebp) {
    return await sharp(buffer).resize({ height }).webp().toBuffer();
  }

  const gif = await imagescript.GIF.decode(buffer);
  const scaleFactor = gif.height / height;
  gif.resize(gif.width / scaleFactor, height);
  return gif.encode();
}
