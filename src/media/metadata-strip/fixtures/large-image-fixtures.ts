import { deflateSync } from 'node:zlib';
import Sharp from 'sharp';
import { pngChunk } from './identifying-image-fixtures';

/**
 * Synthetic images above the pixel check's old 128 MiB decoded budget. They
 * compress well, so the encoded files (and so the strip's own buffers) stay
 * small while the decoded pixels are large. The identifying text is
 * invented and listed in IDENTIFYING_STRINGS.
 */

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function gradientTile(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 3;
      pixels[offset] = (x * 13) & 255;
      pixels[offset + 1] = (y * 7) & 255;
      pixels[offset + 2] = (x ^ y) & 255;
    }
  }
  return pixels;
}

/** Square baseline JPEG, Orientation 6, with identifying EXIF. */
export async function largeJpeg(side: number): Promise<Buffer> {
  return Sharp(gradientTile(240), {
    raw: { width: 240, height: 240, channels: 3 }
  })
    .resize(side, side, { kernel: 'nearest' })
    .withExif({
      IFD0: {
        Make: 'SynthCam Make',
        Model: 'SynthCam Model X',
        Artist: 'Jane Synthetic'
      }
    })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** Inserts an identifying tEXt chunk after IHDR. */
export function withPngTextChunk(png: Buffer): Buffer {
  // IHDR is always the first chunk: signature (8) plus 25 bytes.
  return Buffer.concat([
    png.subarray(0, 33),
    pngChunk('tEXt', Buffer.from('Author\0Jane Synthetic', 'latin1')),
    png.subarray(33)
  ]);
}

/** Uniform semi-transparent RGBA PNG with a text chunk. */
export async function largeRgbaPng(
  width: number,
  height: number
): Promise<Buffer> {
  const png = await Sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 10, g: 120, b: 200, alpha: 0.5 }
    }
  })
    .png({ compressionLevel: 1 })
    .toBuffer();
  return withPngTextChunk(png);
}

export type PaletteColour = readonly [number, number, number];

export function pngPaletteChunk(colours: readonly PaletteColour[]): Buffer {
  return pngChunk('PLTE', Buffer.from(colours.flat()));
}

/**
 * Palette PNG with a text chunk. Entries 0-2 form stripes; entry 3 is used
 * only by the last 64 rows, so changing it changes only the bottom rows.
 */
export function largePalettePng(
  width: number,
  height: number,
  colours: readonly PaletteColour[]
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3;
  const stride = width + 1;
  const templates = [0, 1, 2, 3].map((shift) => {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      row[x + 1] = shift === 3 ? 3 : ((x >> 6) + shift) % 3;
    }
    return row;
  });
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const template = y >= height - 64 ? templates[3] : templates[(y >> 6) % 3];
    template.copy(rows, y * stride);
  }
  return withPngTextChunk(
    Buffer.concat([
      PNG_SIGNATURE,
      pngChunk('IHDR', header),
      pngPaletteChunk(colours),
      pngChunk('IDAT', deflateSync(rows, { level: 1 })),
      pngChunk('IEND', Buffer.alloc(0))
    ])
  );
}

export function gifColorTableBytes(packed: number): number {
  return packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0;
}

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export const GIF_FRAME_SIDE = 300;

const GIF_CYCLE: readonly Rgb[] = [
  { r: 220, g: 40, b: 40 },
  { r: 40, g: 220, b: 40 },
  { r: 40, g: 40, b: 220 },
  { r: 220, g: 220, b: 40 }
];

function solidFrame(colour: Rgb): Promise<Buffer> {
  return Sharp({
    create: {
      width: GIF_FRAME_SIDE,
      height: GIF_FRAME_SIDE,
      channels: 4,
      background: { ...colour, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

/**
 * Looping 300 x 300 GIF, 50 ms a frame, cycling four colours and ending on
 * `lastColour`, with an identifying comment extension.
 */
export async function largeGif(
  frames: number,
  lastColour: Rgb = { r: 250, g: 250, b: 250 }
): Promise<Buffer> {
  const cycle = await Promise.all(GIF_CYCLE.map(solidFrame));
  const last = await solidFrame(lastColour);
  const inputs = Array.from({ length: frames }, (_, index) =>
    index === frames - 1 ? last : cycle[index % cycle.length]
  );
  const gif = await Sharp(inputs, { join: { animated: true } })
    .gif({ delay: inputs.map(() => 50), loop: 0 })
    .toBuffer();
  const headerEnd = 13 + gifColorTableBytes(gif[10]);
  const text = Buffer.from('GIF comment Jane Synthetic', 'latin1');
  return Buffer.concat([
    gif.subarray(0, headerEnd),
    Buffer.from([0x21, 0xfe, text.length]),
    text,
    Buffer.from([0x00]),
    gif.subarray(headerEnd)
  ]);
}
