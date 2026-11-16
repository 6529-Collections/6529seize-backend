import {
  buildTiff,
  identifyingExifTiff,
  syntheticThumbnail
} from '@/media/metadata-strip/fixtures/identifying-image-fixtures';
import { minimalOrientationTiff } from '@/media/metadata-strip/exif-orientation';
import { exifTiffCategories } from './exif-identifying-tags';
import { MetadataCategory } from './metadata-category';

const sorted = (categories: Set<MetadataCategory>) =>
  Array.from(categories).sort((a, b) => a.localeCompare(b));

describe('exifTiffCategories', () => {
  it('finds GPS, serial, owner, capture time, camera and thumbnail', async () => {
    const tiff = identifyingExifTiff(6, await syntheticThumbnail());
    expect(sorted(exifTiffCategories(tiff))).toEqual([
      MetadataCategory.CAMERA,
      MetadataCategory.CAPTURE_TIME,
      MetadataCategory.GPS,
      MetadataCategory.OWNER_ARTIST,
      MetadataCategory.SERIAL,
      MetadataCategory.THUMBNAIL
    ]);
  });

  it('is empty for orientation and layout tags only', () => {
    expect(exifTiffCategories(minimalOrientationTiff(6)).size).toBe(0);
    const technical = buildTiff([
      {
        name: 'ifd0',
        entries: [
          { tag: 0x0112, short: 1 },
          { tag: 0x011a, rationals: [[72, 1]] },
          { tag: 0x011b, rationals: [[72, 1]] },
          { tag: 0x0128, short: 2 },
          { tag: 0x8769, pointer: 'exif' }
        ]
      },
      {
        name: 'exif',
        entries: [
          { tag: 0xa001, short: 1 },
          { tag: 0xa002, long: 32 },
          { tag: 0xa003, long: 16 }
        ]
      }
    ]);
    expect(exifTiffCategories(technical).size).toBe(0);
  });

  it('counts software, exposure and other tags as other', () => {
    const tiff = buildTiff([
      {
        name: 'ifd0',
        entries: [
          { tag: 0x0131, ascii: 'SynthEdit 1.0' },
          { tag: 0x8769, pointer: 'exif' }
        ]
      },
      { name: 'exif', entries: [{ tag: 0x829a, rationals: [[1, 60]] }] }
    ]);
    expect(sorted(exifTiffCategories(tiff))).toEqual([MetadataCategory.OTHER]);
  });

  it('a GPS IFD with only a version is other, not GPS', () => {
    const tiff = buildTiff([
      { name: 'ifd0', entries: [{ tag: 0x8825, pointer: 'gps' }] },
      { name: 'gps', entries: [{ tag: 0x0000, long: 0x02030000 }] }
    ]);
    expect(sorted(exifTiffCategories(tiff))).toEqual([MetadataCategory.OTHER]);
  });

  it('treats an unreadable block as other', () => {
    expect(sorted(exifTiffCategories(Buffer.from('not a tiff')))).toEqual([
      MetadataCategory.OTHER
    ]);
    const truncated = identifyingExifTiff(1).subarray(0, 20);
    expect(exifTiffCategories(truncated).has(MetadataCategory.OTHER)).toBe(
      true
    );
  });
});
