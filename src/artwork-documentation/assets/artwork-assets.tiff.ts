import { createHash } from 'node:crypto';
import type { ArchiveRangeReader } from '@/artwork-documentation/assets/artwork-assets.archive';
import { AssetInspectionError } from '@/artwork-documentation/assets/artwork-assets.inspection';

const MAX_TAGS = 4096;
const MAX_PROFILE_BYTES = 4 * 1024 ** 2;
const TAG_NAMES: Record<number, string> = {
  256: 'width',
  257: 'height',
  258: 'bit_depth',
  259: 'tiff_compression',
  262: 'tiff_photometric_interpretation',
  274: 'orientation',
  277: 'channels',
  284: 'tiff_planar_configuration',
  339: 'tiff_sample_format'
};
type Properties = Record<string, string | number | boolean | null>;
type UnsignedReader = (
  bytes: Buffer,
  offset: number,
  length: 2 | 4 | 8
) => number;
type Layout = {
  big: boolean;
  offsetBytes: 4 | 8;
  countBytes: 2 | 8;
  entryBytes: 12 | 20;
  first: number;
  uint: UnsignedReader;
};
type TagValue = {
  tag: number;
  values: number;
  length: number;
  total: number;
  offset: number;
};

function invalid(): never {
  throw new AssetInspectionError('INVALID_TIFF_DIRECTORY');
}
function unsignedReader(little: boolean): UnsignedReader {
  return (bytes, offset, length) => {
    if (offset + length > bytes.length) return invalid();
    let value: number;
    if (length === 2)
      value = little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
    else if (length === 4)
      value = little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    else
      value = little
        ? bytes.readUInt32LE(offset) + bytes.readUInt32LE(offset + 4) * 2 ** 32
        : bytes.readUInt32BE(offset) * 2 ** 32 + bytes.readUInt32BE(offset + 4);
    if (!Number.isSafeInteger(value)) return invalid();
    return value;
  };
}
async function layout(size: number, read: ArchiveRangeReader): Promise<Layout> {
  const header = await read(0, Math.min(size, 16));
  if (
    header.length < 8 ||
    !['II', 'MM'].includes(header.toString('ascii', 0, 2))
  )
    return invalid();
  const uint = unsignedReader(header.toString('ascii', 0, 2) === 'II');
  const version = uint(header, 2, 2);
  if (![42, 43].includes(version)) return invalid();
  const big = version === 43;
  if (big && (uint(header, 4, 2) !== 8 || uint(header, 6, 2) !== 0))
    return invalid();
  const offsetBytes = big ? 8 : 4;
  const countBytes = big ? 8 : 2;
  const first = uint(header, big ? 8 : 4, offsetBytes);
  if (first < (big ? 16 : 8) || first + countBytes > size) return invalid();
  return {
    big,
    offsetBytes,
    countBytes,
    entryBytes: big ? 20 : 12,
    first,
    uint
  };
}
function tagValue(
  directory: Buffer,
  index: number,
  info: Layout,
  size: number
): TagValue | null {
  const { uint, first, big, countBytes, entryBytes, offsetBytes } = info;
  const entry = countBytes + index * entryBytes;
  const tag = uint(directory, entry, 2);
  if (!TAG_NAMES[tag] && tag !== 34675) return null;
  const type = uint(directory, entry + 2, 2);
  const values = uint(directory, entry + 4, offsetBytes);
  const length = ({ 1: 1, 3: 2, 4: 4, 7: 1, 16: 8 } as Record<number, number>)[
    type
  ];
  if (!length || !values) return null;
  const total = length * values;
  if (!Number.isSafeInteger(total)) return invalid();
  const inlineOffset = entry + (big ? 12 : 8);
  const offset =
    total <= offsetBytes
      ? first + inlineOffset
      : uint(directory, inlineOffset, offsetBytes);
  if (offset + total > size) return invalid();
  return { tag, values, length, total, offset };
}
async function measureProfile(
  value: TagValue,
  read: ArchiveRangeReader
): Promise<Properties> {
  const result: Properties = {
    has_embedded_color_profile: true,
    embedded_color_profile_bytes: value.total
  };
  if (value.total > MAX_PROFILE_BYTES)
    return { ...result, embedded_color_profile_hash_status: 'size_limit' };
  const profile = await read(value.offset, value.total);
  return {
    ...result,
    embedded_color_profile_sha256: createHash('sha256')
      .update(profile)
      .digest('hex'),
    embedded_color_profile_header_valid:
      value.total >= 128 && profile.toString('ascii', 36, 40) === 'acsp'
  };
}
async function measureTag(
  value: TagValue,
  info: Layout,
  read: ArchiveRangeReader
): Promise<Properties> {
  if (value.tag === 34675) return measureProfile(value, read);
  if (value.values > 16) return {};
  const bytes = await read(value.offset, value.total);
  const measured = Array.from({ length: value.values }, (_, item) =>
    value.length === 1
      ? bytes[item]
      : info.uint(bytes, item * value.length, value.length as 2 | 4 | 8)
  );
  return {
    [TAG_NAMES[value.tag]]: measured.every((item) => item === measured[0])
      ? measured[0]
      : measured.join(',')
  };
}

/** Characterize the first image directory with bounded reads, including BigTIFF offsets; never allocate pixels. */
export async function characterizeTiff(
  size: number,
  read: ArchiveRangeReader
): Promise<Properties | null> {
  const info = await layout(size, read);
  const { uint, first, countBytes, entryBytes, offsetBytes } = info;
  const count = uint(await read(first, countBytes), 0, countBytes);
  if (count > MAX_TAGS) return null;
  const directoryBytes = countBytes + count * entryBytes + offsetBytes;
  if (first + directoryBytes > size) return invalid();
  const directory = await read(first, directoryBytes);
  const result: Properties = {
    tiff_variant: info.big ? 'BigTIFF' : 'TIFF',
    tiff_characterization_scope: 'first_image_directory',
    tiff_first_directory_tags: count,
    tiff_has_more_image_directories:
      uint(directory, directoryBytes - offsetBytes, offsetBytes) !== 0
  };
  const seen = new Set<number>();
  for (let index = 0; index < count; index++) {
    const value = tagValue(directory, index, info, size);
    if (!value) continue;
    if (seen.has(value.tag)) return invalid();
    seen.add(value.tag);
    Object.assign(result, await measureTag(value, info, read));
  }
  return result;
}
