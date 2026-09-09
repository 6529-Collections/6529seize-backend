import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import { ARTWORK_FORMATS } from '@/artwork-documentation/assets/artwork-assets.policy';

export class AssetInspectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
const PREFIX_LIMIT = 64 * 1024;
export const PREVIEW_FILE_LIMIT = 256 * 1024 * 1024;
export const PREVIEW_PIXEL_LIMIT = 100_000_000;
export const PREVIEW_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'tif',
  'tiff',
  'webp',
  'gif'
];
const TEXT_EXTENSIONS = ['txt', 'md', 'xmp'];

/** Stream the entire object once. The prefix and decoder buffers are strictly bounded. */
export async function hashAssetStream(
  stream: Readable,
  expectedSize: number,
  extension: string,
  signal: AbortSignal,
  previewFile?: string
): Promise<{ sha256: string; size: number; prefix: Buffer }> {
  const hash = createHash('sha256');
  const decoder = TEXT_EXTENSIONS.includes(extension)
    ? new TextDecoder('utf-8', { fatal: true })
    : null;
  let size = 0;
  let prefix = Buffer.alloc(0);
  let textTail = '';
  const decodeText = (bytes?: Buffer): string => {
    try {
      return bytes
        ? decoder!.decode(bytes, { stream: true })
        : decoder!.decode();
    } catch {
      throw new AssetInspectionError('INVALID_TEXT_ENCODING');
    }
  };
  const inspectText = (text: string) => {
    if (text.includes('\u0000'))
      throw new AssetInspectionError('INVALID_TEXT_ENCODING');
    if (extension === 'xmp') {
      const combined = textTail + text;
      if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(combined))
        throw new AssetInspectionError('UNSAFE_XML_DECLARATION');
      textTail = combined.slice(-64);
    }
  };
  const inspector = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        size += chunk.length;
        if (size > expectedSize)
          throw new AssetInspectionError('UPLOAD_SIZE_MISMATCH');
        hash.update(chunk);
        if (prefix.length < PREFIX_LIMIT)
          prefix = Buffer.concat([
            prefix,
            chunk.subarray(0, PREFIX_LIMIT - prefix.length)
          ]);
        if (decoder) inspectText(decodeText(chunk));
        callback(null, chunk);
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error('Inspection failed')
        );
      }
    }
  });
  const sink = previewFile
    ? createWriteStream(previewFile, { flags: 'wx', mode: 0o600 })
    : new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        }
      });
  try {
    await pipeline(stream, inspector, sink, { signal });
    if (decoder) inspectText(decodeText());
  } catch (error) {
    if (error instanceof TypeError && decoder)
      throw new AssetInspectionError('INVALID_TEXT_ENCODING');
    throw error;
  }
  if (size !== expectedSize)
    throw new AssetInspectionError('UPLOAD_SIZE_MISMATCH');
  return { sha256: hash.digest('hex'), size, prefix };
}

function starts(header: Buffer, text: string, offset = 0): boolean {
  return header
    .subarray(offset, offset + text.length)
    .equals(Buffer.from(text, 'binary'));
}
function isTiff(header: Buffer): boolean {
  return (
    starts(header, 'II*\0') ||
    starts(header, 'MM\0*') ||
    starts(header, 'II+\0') ||
    starts(header, 'MM\0+')
  );
}
function hasBrand(header: Buffer, brands: string[]): boolean {
  if (!starts(header, 'ftyp', 4)) return false;
  const boxSize =
    header.length >= 4
      ? Math.min(header.readUInt32BE(0), header.length, 4096)
      : 0;
  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    if (
      offset !== 12 &&
      brands.includes(header.toString('ascii', offset, offset + 4))
    )
      return true;
  }
  return false;
}
function validSignature(header: Buffer, extension: string): boolean {
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    case 'png':
      return header
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'tif':
    case 'tiff':
    case 'dng':
    case 'nef':
    case 'nrw':
    case 'arw':
      return isTiff(header);
    case 'cr2':
      return isTiff(header) && starts(header, 'CR', 8);
    case 'cr3':
      return hasBrand(header, ['crx ']);
    case 'raf':
      return starts(header, 'FUJIFILMCCD-RAW');
    case 'orf':
      return (
        starts(header, 'IIRO') ||
        starts(header, 'IIRS') ||
        starts(header, 'MMOR')
      );
    case 'rw2':
      return starts(header, 'IIU\0');
    case 'gif':
      return starts(header, 'GIF87a') || starts(header, 'GIF89a');
    case 'webp':
      return starts(header, 'RIFF') && starts(header, 'WEBP', 8);
    case 'heic':
    case 'heif':
      return hasBrand(header, ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
    case 'psd':
      return starts(header, '8BPS') && header[4] === 0 && header[5] === 1;
    case 'psb':
      return starts(header, '8BPS') && header[4] === 0 && header[5] === 2;
    case 'pdf':
      return starts(header, '%PDF-');
    case 'wav':
      return (
        (starts(header, 'RIFF') || starts(header, 'RF64')) &&
        starts(header, 'WAVE', 8)
      );
    case 'flac':
      return starts(header, 'fLaC');
    case 'mp3':
      return (
        starts(header, 'ID3') ||
        (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)
      );
    case 'm4a':
      return hasBrand(header, ['M4A ', 'M4B ', 'isom', 'mp42']);
    case 'mp4':
      return hasBrand(header, [
        'isom',
        'iso2',
        'iso4',
        'iso5',
        'iso6',
        'mp41',
        'mp42',
        'avc1',
        'dash',
        'MSNV'
      ]);
    case 'mov':
      return (
        hasBrand(header, ['qt  ']) ||
        ['moov', 'mdat', 'wide'].some((type) => starts(header, type, 4))
      );
    case 'txt':
    case 'md':
      return !/^\s*<(?:!doctype\s+html|html|svg)\b/i.test(
        header.toString('utf8')
      );
    case 'xmp':
      return /(?:<\?xml|<\?xpacket|<x:xmpmeta|<rdf:RDF)/.test(
        header.toString('utf8')
      );
    default:
      return false;
  }
}

/** Magic validation never claims semantic/vendor RAW inspection was performed. */
export function inspectAssetHeader(
  header: Buffer,
  extension: string
): { detected_mime: string; inspection_status: 'verified' | 'unsupported' } {
  if (!ARTWORK_FORMATS[extension] || !validSignature(header, extension))
    throw new AssetInspectionError('FILE_SIGNATURE_MISMATCH');
  return {
    detected_mime: ARTWORK_FORMATS[extension][0],
    inspection_status:
      PREVIEW_EXTENSIONS.includes(extension) ||
      TEXT_EXTENSIONS.includes(extension)
        ? 'verified'
        : 'unsupported'
  };
}
