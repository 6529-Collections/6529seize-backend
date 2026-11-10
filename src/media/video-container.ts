/**
 * Video containers that may be stored and served from our media origin. The
 * content type always comes from the bytes, never from a remote server.
 */
export type StorableVideoContentType =
  | 'video/mp4'
  | 'video/webm'
  | 'video/quicktime';

const VIDEO_EXTENSIONS: Readonly<Record<StorableVideoContentType, string>> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
};

const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'avc1',
  'hev1',
  'hvc1',
  'mp41',
  'mp42',
  'm4v ',
  'dash'
]);

// Classic QuickTime files may start with a top-level atom instead of 'ftyp'.
const QUICKTIME_LEADING_ATOMS = new Set(['moov', 'mdat', 'wide']);

function asciiAt(bytes: Buffer, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  return bytes.toString('latin1', offset, offset + length);
}

function isoBrands(bytes: Buffer): { major: string; all: string[] } | null {
  if (asciiAt(bytes, 4, 4) !== 'ftyp') return null;
  const boxSize = bytes.readUInt32BE(0);
  const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : 16, 64);
  const all: string[] = [];
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    // Offset 12 is the minor version, not a brand.
    if (offset !== 12) all.push(asciiAt(bytes, offset, 4).toLowerCase());
  }
  return { major: all[0] ?? '', all };
}

function isWebm(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false;
  // The EBML header carries the DocType; Matroska ('matroska') is not WebM.
  return bytes
    .subarray(0, Math.min(bytes.length, 64))
    .toString('latin1')
    .includes('webm');
}

export function detectStorableVideoContentType(
  bytes: Buffer
): StorableVideoContentType | null {
  if (isWebm(bytes)) return 'video/webm';
  const brands = isoBrands(bytes);
  if (brands) {
    if (brands.major === 'qt  ') return 'video/quicktime';
    if (brands.all.some((brand) => MP4_BRANDS.has(brand) || /^mp4/.test(brand)))
      return 'video/mp4';
    return null;
  }
  if (QUICKTIME_LEADING_ATOMS.has(asciiAt(bytes, 4, 4))) {
    return 'video/quicktime';
  }
  return null;
}

export function videoExtensionForContentType(
  contentType: StorableVideoContentType
): string {
  return VIDEO_EXTENSIONS[contentType];
}
