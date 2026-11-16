import Sharp from 'sharp';
import {
  identifyingGif,
  identifyingJpeg,
  identifyingPng,
  identifyingWebp,
  IDENTIFYING_STRINGS
} from '@/media/metadata-strip/fixtures/identifying-image-fixtures';
import { identifyingUltraHdrJpeg } from '@/media/metadata-strip/fixtures/hdr-image-fixtures';
import {
  describeImageContainer,
  LosslessStripFormat,
  stripMetadataLosslessly
} from '@/media/metadata-strip/lossless-metadata-strip';
import { findIdentifyingMetadata } from './identifying-metadata';
import { sniffImageContainer } from './image-container';
import { MetadataCategory } from './metadata-category';

function categoriesOf(input: Buffer, format: LosslessStripFormat) {
  const { metadataBlocks } = describeImageContainer(input, format);
  return findIdentifyingMetadata(input, format, metadataBlocks).categories;
}

describe('findIdentifyingMetadata', () => {
  it('classifies every identifying block of a camera JPEG', async () => {
    const { jpeg } = await identifyingJpeg();
    expect(categoriesOf(jpeg, 'jpeg')).toEqual([
      MetadataCategory.CAMERA,
      MetadataCategory.CAPTURE_TIME,
      MetadataCategory.GPS,
      MetadataCategory.OTHER,
      MetadataCategory.OWNER_ARTIST,
      MetadataCategory.SERIAL,
      MetadataCategory.THUMBNAIL,
      MetadataCategory.XMP_IPTC
    ]);
  });

  it('classifies PNG text, time and EXIF chunks', async () => {
    expect(categoriesOf(await identifyingPng(), 'png')).toEqual(
      expect.arrayContaining([
        MetadataCategory.CAPTURE_TIME,
        MetadataCategory.GPS,
        MetadataCategory.OWNER_ARTIST,
        MetadataCategory.XMP_IPTC,
        MetadataCategory.OTHER
      ])
    );
  });

  it('classifies WebP EXIF/XMP and GIF comments and XMP', async () => {
    expect(categoriesOf(await identifyingWebp(), 'webp')).toEqual(
      expect.arrayContaining([
        MetadataCategory.CAMERA,
        MetadataCategory.OWNER_ARTIST,
        MetadataCategory.XMP_IPTC
      ])
    );
    expect(categoriesOf(identifyingGif(), 'gif')).toEqual([
      MetadataCategory.OTHER,
      MetadataCategory.OWNER_ARTIST,
      MetadataCategory.XMP_IPTC
    ]);
  });

  it('is empty for a clean image and for technical EXIF only', async () => {
    const clean = await Sharp({
      create: { width: 4, height: 4, channels: 3, background: '#123456' }
    })
      .jpeg()
      .toBuffer();
    expect(categoriesOf(clean, 'jpeg')).toEqual([]);
    const technical = await Sharp(clean)
      .withExif({ IFD0: { XResolution: '72/1', ResolutionUnit: '2' } })
      .jpeg()
      .toBuffer();
    const { metadataBlocks } = describeImageContainer(technical, 'jpeg');
    expect(metadataBlocks).toContain('APP1:Exif');
    expect(
      findIdentifyingMetadata(technical, 'jpeg', metadataBlocks).categories
    ).toEqual([]);
  });

  it('judges gain map blocks on the gain map and ignores HDR structure', async () => {
    const { jpeg } = await identifyingUltraHdrJpeg();
    const categories = categoriesOf(jpeg, 'jpeg');
    expect(categories).toEqual(
      expect.arrayContaining([MetadataCategory.GPS, MetadataCategory.XMP_IPTC])
    );
    const { output } = stripMetadataLosslessly(jpeg, 'jpeg');
    expect(describeImageContainer(output, 'jpeg').metadataBlocks).toEqual([]);
    expect(
      findIdentifyingMetadata(output, 'jpeg', ['APP2:MPF', 'APP1:XMP'])
        .categories
    ).toEqual([]);
    expect(
      findIdentifyingMetadata(output, 'jpeg', ['GainMap:COM']).categories
    ).toEqual([MetadataCategory.OTHER]);
  });

  it('counts an unknown removable block as other', () => {
    expect(
      findIdentifyingMetadata(Buffer.alloc(0), 'png', ['caBX']).categories
    ).toEqual([MetadataCategory.OTHER]);
  });

  it('returns categories only, never values', async () => {
    const { jpeg } = await identifyingJpeg();
    const serialized = JSON.stringify(categoriesOf(jpeg, 'jpeg'));
    for (const value of IDENTIFYING_STRINGS) {
      expect(serialized).not.toContain(value);
    }
  });
});

describe('sniffImageContainer', () => {
  it('detects formats from bytes and names unsupported ones', () => {
    expect(sniffImageContainer(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      kind: 'supported',
      format: 'jpeg'
    });
    expect(sniffImageContainer(Buffer.from('GIF89a......'))).toEqual({
      kind: 'supported',
      format: 'gif'
    });
    expect(sniffImageContainer(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({
      kind: 'supported',
      format: 'webp'
    });
    expect(
      sniffImageContainer(Buffer.from('89504e470d0a1a0a0000', 'hex'))
    ).toEqual({ kind: 'supported', format: 'png' });
    expect(sniffImageContainer(Buffer.from('\0\0\0\x1cftypavif0000'))).toEqual({
      kind: 'unsupported',
      name: 'avif'
    });
    expect(sniffImageContainer(Buffer.from('\0\0\0\x18ftypheic0000'))).toEqual({
      kind: 'unsupported',
      name: 'heif'
    });
    expect(sniffImageContainer(Buffer.from('<svg xmlns='))).toEqual({
      kind: 'unsupported',
      name: 'svg-or-xml'
    });
    expect(sniffImageContainer(Buffer.from('II*\0abcd'))).toEqual({
      kind: 'unsupported',
      name: 'tiff'
    });
  });
});
