import { AssetInspectionError } from '@/artwork-documentation/assets/artwork-assets.inspection';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const TABLE_WIDTHS: Record<string, number> = {
  stts: 8,
  ctts: 8,
  stsc: 12,
  stco: 4,
  co64: 8,
  stss: 4
};

function invalid(): never {
  throw new AssetInspectionError('INVALID_MEDIA_CONTAINER');
}

function tableFits(count: number, width: number, available: number): void {
  if (Math.ceil(count * width) > available) invalid();
}

function validateTable(
  bytes: Buffer,
  type: string,
  start: number,
  end: number,
  sourceBytes: number
): void {
  if (type === 'stsz' || type === 'stz2') {
    if (end - start < 12) invalid();
    const count = bytes.readUInt32BE(start + 8);
    if (type === 'stsz') {
      const sampleBytes = bytes.readUInt32BE(start + 4);
      if (sampleBytes) tableFits(count, sampleBytes, sourceBytes);
      else tableFits(count, 4, end - start - 12);
    } else {
      const bits = bytes[start + 7];
      if (![4, 8, 16].includes(bits)) invalid();
      tableFits(count, bits / 8, end - start - 12);
    }
  } else if (Object.prototype.hasOwnProperty.call(TABLE_WIDTHS, type)) {
    if (end - start < 8) invalid();
    tableFits(
      bytes.readUInt32BE(start + 4),
      TABLE_WIDTHS[type],
      end - start - 8
    );
  }
}

/** Validate encoded table extents without expanding sample runs or trusting declared counts. */
export function validateMp4Tables(bytes: Buffer, sourceBytes: number): void {
  let boxes = 0;
  const walk = (start: number, end: number, depth: number): void => {
    if (depth > 8) invalid();
    for (let offset = start; offset < end; ) {
      if (++boxes > 8192 || end - offset < 8) invalid();
      const shortSize = bytes.readUInt32BE(offset);
      const headerSize = shortSize === 1 ? 16 : 8;
      if (end - offset < headerSize) invalid();
      const size =
        shortSize === 1
          ? bytes.readUInt32BE(offset + 8) * 2 ** 32 +
            bytes.readUInt32BE(offset + 12)
          : shortSize || end - offset;
      if (
        !Number.isSafeInteger(size) ||
        size < headerSize ||
        size > end - offset
      )
        invalid();
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      const body = offset + headerSize;
      const next = offset + size;
      if (CONTAINERS.has(type)) walk(body, next, depth + 1);
      else validateTable(bytes, type, body, next, sourceBytes);
      offset = next;
    }
  };
  walk(0, bytes.length, 0);
}
