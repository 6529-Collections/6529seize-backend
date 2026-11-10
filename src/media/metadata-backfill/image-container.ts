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

/** Extensions mapped to the container names `sniffImageContainer` reports. */
const EXTENSION_CONTAINERS: Readonly<Record<string, string>> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  jfif: 'jpeg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif',
  heic: 'heif',
  heif: 'heif',
  tif: 'tiff',
  tiff: 'tiff',
  bmp: 'bmp',
  svg: 'svg-or-xml'
};

/**
 * The key's extension when it names a different container than the bytes
 * hold; null when they agree or the key has no extension.
 */
export function extensionMismatch(
  key: string,
  sniffed: SniffedImage
): { extension: string; container: string } | null {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const container =
    sniffed.kind === 'supported' ? sniffed.format : sniffed.name;
  const expected = EXTENSION_CONTAINERS[extension] ?? extension;
  return expected === container ? null : { extension, container };
}
