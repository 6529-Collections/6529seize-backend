import fc from 'fast-check';
import {
  isOrientationOnlyTiff,
  minimalOrientationTiff,
  readTiffOrientation,
  withoutExifHeader
} from './exif-orientation';
import { identifyingExifTiff } from './fixtures/identifying-image-fixtures';

describe('EXIF orientation helpers', () => {
  it('reads orientation from a little-endian TIFF with other tags', () => {
    expect(readTiffOrientation(identifyingExifTiff(6))).toBe(6);
  });

  it('round-trips every orientation through the minimal big-endian TIFF', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (orientation) => {
        const tiff = minimalOrientationTiff(orientation);
        expect(readTiffOrientation(tiff)).toBe(orientation);
        expect(isOrientationOnlyTiff(tiff)).toBe(true);
      })
    );
  });

  it('does not treat an EXIF block with any other tag as orientation-only', () => {
    expect(isOrientationOnlyTiff(identifyingExifTiff(1))).toBe(false);
  });

  it('treats unreadable or out-of-range orientation as upright', () => {
    const outOfRange = minimalOrientationTiff(1);
    outOfRange.writeUInt16BE(9, 18);
    expect(readTiffOrientation(outOfRange)).toBe(1);
    expect(readTiffOrientation(Buffer.from('not a tiff'))).toBe(1);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const orientation = readTiffOrientation(Buffer.from(bytes));
        expect(orientation).toBeGreaterThanOrEqual(1);
        expect(orientation).toBeLessThanOrEqual(8);
      })
    );
  });

  it('accepts EXIF blocks with or without the JPEG Exif prefix', () => {
    const tiff = minimalOrientationTiff(3);
    expect(
      withoutExifHeader(Buffer.concat([Buffer.from('Exif\0\0'), tiff]))
    ).toEqual(tiff);
    expect(withoutExifHeader(tiff)).toEqual(tiff);
  });
});
