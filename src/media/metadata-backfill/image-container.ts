import { LosslessStripFormat } from '@/media/metadata-strip/lossless-metadata-strip';

export type SniffedImage =
  | { readonly kind: 'supported'; readonly format: LosslessStripFormat }
  | { readonly kind: 'unsupported'; readonly name: string };

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function isoMediaBrand(input: Buffer): string | null {
  if (input.length < 12 || input.toString('latin1', 4, 8) !== 'ftyp') {
    return null;
  }
  const brand = input.toString('latin1', 8, 12);
  if (brand === 'avif' || brand === 'avis') return 'avif';
  if (
    ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)
  ) {
    return 'heif';
  }
  return 'iso-media';
}

function unsupportedName(input: Buffer): string {
  const brand = isoMediaBrand(input);
  if (brand) return brand;
  const head = input.toString('latin1', 0, 4);
  if (head === 'II*\0' || head === 'MM\0*') return 'tiff';
  if (head.startsWith('BM')) return 'bmp';
  if (head.trimStart().startsWith('<')) return 'svg-or-xml';
  return 'unknown';
}

/** The container from the bytes themselves; the stored Content-Type is not evidence. */
export function sniffImageContainer(input: Buffer): SniffedImage {
  if (
    input.length >= 3 &&
    input[0] === 0xff &&
    input[1] === 0xd8 &&
    input[2] === 0xff
  ) {
    return { kind: 'supported', format: 'jpeg' };
  }
  if (input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { kind: 'supported', format: 'png' };
  }
  if (
    input.length >= 12 &&
    input.toString('latin1', 0, 4) === 'RIFF' &&
    input.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return { kind: 'supported', format: 'webp' };
  }
  const gif = input.toString('latin1', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return { kind: 'supported', format: 'gif' };
  }
  return { kind: 'unsupported', name: unsupportedName(input) };
}
