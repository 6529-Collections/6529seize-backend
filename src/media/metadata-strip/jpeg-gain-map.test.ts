import { createHash } from 'node:crypto';
import fc from 'fast-check';
import Sharp from 'sharp';
import { Logger } from '@/logging';
import * as lossless from './lossless-metadata-strip';
import {
  describeImageContainer,
  stripMetadataLosslessly
} from './lossless-metadata-strip';
import { stripMetadataWithPixelCheck } from './pixel-verified-metadata-strip';
import {
  IDENTIFYING_STRINGS,
  identifyingJpeg,
  jpegSegment
} from './fixtures/identifying-image-fixtures';
import {
  identifyingAppleHdrJpeg,
  identifyingUltraHdrJpeg,
  ISO_VERSION_ONLY,
  isoGainMapMetadata,
  MPF_LARGE_THUMBNAIL_TYPE,
  MPF_PRIMARY_TYPE,
  MPF_REPRESENTATIVE,
  MPF_UNDEFINED_TYPE
} from './fixtures/hdr-image-fixtures';

const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const ISO_ID = 'urn:iso:std:iso:ts:21496:-1\0';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ALLOWED_XMP_NAMESPACES: Record<string, string> = {
  x: 'adobe:ns:meta/',
  rdf: RDF,
  hdrgm: 'http://ns.adobe.com/hdr-gain-map/1.0/',
  Container: 'http://ns.google.com/photos/1.0/container/',
  Item: 'http://ns.google.com/photos/1.0/container/item/',
  HDRGainMap: 'http://ns.apple.com/HDRGainMap/1.0/',
  apdi: 'http://ns.apple.com/pixeldatainfo/1.0/'
};

interface HeaderSegment {
  readonly marker: number;
  readonly start: number;
  readonly payload: Buffer;
}

/** Segments before the first scan, read independently of the module. */
function headerSegments(jpeg: Buffer): HeaderSegment[] {
  const segments: HeaderSegment[] = [];
  let position = 2;
  while (jpeg[position] === 0xff && jpeg[position + 1] !== 0xda) {
    const length = jpeg.readUInt16BE(position + 2);
    segments.push({
      marker: jpeg[position + 1],
      start: position,
      payload: jpeg.subarray(position + 4, position + 2 + length)
    });
    position += 2 + length;
  }
  return segments;
}

function payloadsAfter(jpeg: Buffer, signature: string): Buffer[] {
  return headerSegments(jpeg)
    .filter(
      (segment) =>
        segment.payload.toString('latin1', 0, signature.length) === signature
    )
    .map((segment) => segment.payload.subarray(signature.length));
}

function payloadAfter(jpeg: Buffer, signature: string): Buffer | undefined {
  const payloads = payloadsAfter(jpeg, signature);
  expect(payloads.length).toBeLessThanOrEqual(1);
  return payloads[0];
}

/** A big-endian MP Index, as the strip writes it. */
function mpfIndex(jpeg: Buffer) {
  const segment = headerSegments(jpeg).find(
    (candidate) => candidate.payload.toString('latin1', 0, 4) === 'MPF\0'
  )!;
  const tiff = segment.payload.subarray(4);
  expect(tiff.toString('latin1', 0, 4)).toBe('MM\0*');
  const ifd = tiff.readUInt32BE(4);
  const tags: number[] = [];
  let count = 0;
  let entriesAt = 0;
  for (let index = 0; index < tiff.readUInt16BE(ifd); index++) {
    const at = ifd + 2 + index * 12;
    tags.push(tiff.readUInt16BE(at));
    if (tiff.readUInt16BE(at) === 0xb001) count = tiff.readUInt32BE(at + 8);
    if (tiff.readUInt16BE(at) === 0xb002) entriesAt = tiff.readUInt32BE(at + 8);
  }
  const entries = Array.from({ length: count }, (_, index) => ({
    attribute: tiff.readUInt32BE(entriesAt + index * 16),
    size: tiff.readUInt32BE(entriesAt + index * 16 + 4),
    offset: tiff.readUInt32BE(entriesAt + index * 16 + 8)
  }));
  return { tiffStart: segment.start + 8, tags, entries };
}

/** The gain map, found by following the MPF index to an SOI. */
function gainMapViaMpf(jpeg: Buffer): Buffer {
  const { tiffStart, entries } = mpfIndex(jpeg);
  expect(entries).toHaveLength(2);
  const start = tiffStart + entries[1].offset;
  expect(jpeg.subarray(start, start + 3)).toEqual(
    Buffer.from([0xff, 0xd8, 0xff])
  );
  expect(entries[0]).toMatchObject({ size: start, offset: 0 });
  expect(start + entries[1].size).toBe(jpeg.length);
  return jpeg.subarray(start);
}

async function pixelHash(image: Buffer) {
  const { data, info } = await Sharp(image)
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    channels: info.channels,
    hash: createHash('sha256').update(data).digest('hex')
  };
}

function matches(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found.push(match[1]);
  return found;
}

/** Every element and attribute is in an allowlisted, gain map namespace. */
function expectOnlyGainMapXmp(xmp: string) {
  const prefixes = matches(xmp, /<\/?([A-Za-z]+):/g).concat(
    matches(xmp, /\s([A-Za-z]+):[A-Za-z]+=/g).filter(
      (prefix) => prefix !== 'xmlns'
    )
  );
  for (const prefix of prefixes) {
    expect(Object.keys(ALLOWED_XMP_NAMESPACES)).toContain(prefix);
  }
  const declarations = matches(xmp, /\sxmlns:([A-Za-z]+="[^"]*")/g);
  for (const declaration of declarations) {
    const [prefix, uri] = declaration.split('=');
    expect(`"${ALLOWED_XMP_NAMESPACES[prefix]}"`).toBe(uri);
  }
}

function expectNoIdentifyingData(image: Buffer, thumbnail: Buffer) {
  const text = image.toString('latin1');
  for (const value of [
    ...IDENTIFYING_STRINGS,
    'Exif\0\0II',
    'Photoshop 3.0',
    'THUMB1',
    'SYNTH-SERIAL',
    'GDepth',
    'portraiteffectsmatte',
    'xpacket'
  ]) {
    expect(text).not.toContain(value);
  }
  expect(image.indexOf(thumbnail)).toBe(-1);
}

function expectDropped(output: Buffer, images: readonly Buffer[]) {
  for (const image of images) {
    expect(output.indexOf(image.subarray(image.length - 48))).toBe(-1);
  }
}

async function expectCleanImageMetadata(image: Buffer) {
  const metadata = await Sharp(image).metadata();
  expect(metadata.exif).toBeUndefined();
  expect(metadata.iptc).toBeUndefined();
  expect(metadata.comments).toBeUndefined();
}

function primaryXmp(gainMapLength: number): string {
  return (
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}">` +
    '<rdf:Description rdf:about=""' +
    ' xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"' +
    ' xmlns:Container="http://ns.google.com/photos/1.0/container/"' +
    ' xmlns:Item="http://ns.google.com/photos/1.0/container/item/"' +
    ' hdrgm:Version="1.0"><Container:Directory><rdf:Seq>' +
    '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary"' +
    ' Item:Mime="image/jpeg"/></rdf:li>' +
    '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap"' +
    ` Item:Mime="image/jpeg" Item:Length="${gainMapLength}"/></rdf:li>` +
    '</rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>'
  );
}

const ULTRA_HDR_GAIN_MAP_XMP =
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}">` +
  '<rdf:Description rdf:about=""' +
  ' xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"' +
  ' hdrgm:BaseRenditionIsHDR="False" hdrgm:GainMapMin="0" hdrgm:Gamma="1"' +
  ' hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625"' +
  ' hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="2.3">' +
  '<hdrgm:GainMapMax><rdf:Seq><rdf:li>2.3</rdf:li><rdf:li>2.25</rdf:li>' +
  '<rdf:li>2.2</rdf:li></rdf:Seq></hdrgm:GainMapMax>' +
  '</rdf:Description></rdf:RDF></x:xmpmeta>';

const APPLE_GAIN_MAP_XMP =
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF}">` +
  '<rdf:Description rdf:about=""' +
  ' xmlns:HDRGainMap="http://ns.apple.com/HDRGainMap/1.0/"' +
  ' xmlns:apdi="http://ns.apple.com/pixeldatainfo/1.0/">' +
  '<HDRGainMap:HDRGainMapVersion>131072</HDRGainMap:HDRGainMapVersion>' +
  '<HDRGainMap:HDRGainMapHeadroom>3.4</HDRGainMap:HDRGainMapHeadroom>' +
  '<apdi:AuxiliaryImageType>urn:com:apple:photo:2020:aux:hdrgainmap</apdi:AuxiliaryImageType>' +
  '<apdi:NativeFormat>1278226488</apdi:NativeFormat>' +
  '<apdi:StoredFormat>1278226488</apdi:StoredFormat>' +
  '</rdf:Description></rdf:RDF></x:xmpmeta>';

describe('stripMetadataLosslessly: Ultra HDR gain maps', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps a parseable gain map and removes identifying data from both images', async () => {
    const fixture = await identifyingUltraHdrJpeg();
    const { output, input, gainMaps } = stripMetadataLosslessly(
      fixture.jpeg,
      'jpeg'
    );

    expect(gainMaps).toEqual({ kind: 'kept', count: 1 });
    expect(input.metadataBlocks).toEqual([
      'APP0:JFIF-thumbnail',
      'APP1:Exif',
      'APP1:XMP',
      'APP13',
      'COM',
      'APP2:MPF',
      'GainMap:APP0:JFIF-thumbnail',
      'GainMap:APP1:Exif',
      'GainMap:APP1:XMP',
      'GainMap:COM',
      'trailing-data'
    ]);

    // MPF: a minimal index of the primary image and the gain map only, with
    // the dependency flag cleared and the offset landing on the gain map SOI.
    const mpf = mpfIndex(output);
    expect(mpf.tags).toEqual([0xb000, 0xb001, 0xb002]);
    expect(mpf.entries.map((entry) => entry.attribute)).toEqual([
      MPF_REPRESENTATIVE | MPF_PRIMARY_TYPE,
      MPF_UNDEFINED_TYPE
    ]);
    const gainMap = gainMapViaMpf(output);

    // XMP: gain map values and a container directory whose length matches.
    const xmp = payloadAfter(output, XMP_ID)!.toString('utf8');
    expect(xmp).toBe(primaryXmp(gainMap.length));
    expectOnlyGainMapXmp(xmp);
    const gainMapXmp = payloadAfter(gainMap, XMP_ID)!.toString('utf8');
    expect(gainMapXmp).toBe(ULTRA_HDR_GAIN_MAP_XMP);
    expectOnlyGainMapXmp(gainMapXmp);
    expect(payloadAfter(output, ISO_ID)).toEqual(ISO_VERSION_ONLY);
    expect(payloadAfter(gainMap, ISO_ID)).toEqual(isoGainMapMetadata());

    // libultrahdr (through libvips) still finds the same gain map.
    const metadata = await Sharp(output).metadata();
    expect(metadata.gainMap?.image).toEqual(gainMap);
    expect(metadata.icc).toEqual((await Sharp(fixture.jpeg).metadata()).icc);

    expect(await pixelHash(output)).toEqual(await pixelHash(fixture.jpeg));
    expect(await pixelHash(gainMap)).toEqual(await pixelHash(fixture.gainMap));
    expectNoIdentifyingData(output, fixture.thumbnail);
    expectDropped(output, fixture.dropped);
    await expectCleanImageMetadata(output);
    await expectCleanImageMetadata(gainMap);

    const again = stripMetadataLosslessly(output, 'jpeg');
    expect(again.output).toEqual(output);
    expect(again.input.metadataBlocks).toEqual([]);
    expect(again.gainMaps).toEqual({ kind: 'kept', count: 1 });
  });

  it('keeps the gain map of a libultrahdr-encoded JPEG that sharp can still read', async () => {
    const pixels = Buffer.alloc(48 * 24 * 3);
    for (let index = 0; index < pixels.length; index++) {
      pixels[index] = (index * 5) & 0xff;
    }
    // sharp 0.35's experimental gain map encoder (libultrahdr) is untyped.
    const image = Sharp(pixels, {
      raw: { width: 48, height: 24, channels: 3 }
    }) as ReturnType<typeof Sharp> & {
      withGainMap(): ReturnType<typeof Sharp>;
    };
    const encoded = await image.withGainMap().jpeg().toBuffer();
    const before = await Sharp(encoded).metadata();
    expect(before.gainMap).toBeDefined();

    const { output, gainMaps } = stripMetadataLosslessly(encoded, 'jpeg');

    expect(gainMaps).toEqual({ kind: 'kept', count: 1 });
    const after = await Sharp(output).metadata();
    expect(after.gainMap?.image).toEqual(gainMapViaMpf(output));
    expect(await pixelHash(after.gainMap!.image)).toEqual(
      await pixelHash(before.gainMap!.image)
    );
    expect(await pixelHash(output)).toEqual(await pixelHash(encoded));
    expect(output.toString('latin1')).not.toContain('libuhdr');
  });

  it('drops a gain map whose MPF entry misses its SOI and keeps the verified SDR base', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const fixture = await identifyingUltraHdrJpeg({ offsetSkew: 1 });
    const reason =
      'MPF entry does not point to a JPEG image after the primary image';

    const { output, input, gainMaps } = stripMetadataLosslessly(
      fixture.jpeg,
      'jpeg'
    );

    expect(gainMaps).toEqual({ kind: 'dropped', reason });
    expect(input.gainMapIssue).toBe(reason);
    expect(warn).toHaveBeenCalledWith(
      `Dropped a JPEG HDR gain map and kept the SDR base image: ${reason}`
    );
    const text = output.toString('latin1');
    for (const marker of ['MPF\0', ISO_ID, 'x:xmpmeta']) {
      expect(text).not.toContain(marker);
    }
    expect((await Sharp(output).metadata()).gainMap).toBeUndefined();
    expect(output.indexOf(fixture.gainMap.subarray(-48))).toBe(-1);
    expect(await pixelHash(output)).toEqual(await pixelHash(fixture.jpeg));
    expectNoIdentifyingData(output, fixture.thumbnail);
    expect(stripMetadataLosslessly(output, 'jpeg')).toMatchObject({
      output,
      input: { metadataBlocks: [] },
      gainMaps: undefined
    });
  });

  it('drops the gain maps on request, without a warning', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const fixture = await identifyingUltraHdrJpeg();

    const { output, gainMaps } = stripMetadataLosslessly(fixture.jpeg, 'jpeg', {
      gainMaps: 'drop'
    });

    expect(gainMaps).toEqual({ kind: 'dropped', reason: 'Not requested' });
    expect(warn).not.toHaveBeenCalled();
    expect(output.toString('latin1')).not.toContain('MPF\0');
    expect(await pixelHash(output)).toEqual(await pixelHash(fixture.jpeg));
  });

  it('warns when the primary image announces a gain map that is missing', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { jpeg } = await identifyingJpeg();
    const announced = Buffer.concat([
      jpeg.subarray(0, 2),
      jpegSegment(0xe2, Buffer.concat([Buffer.from(ISO_ID), ISO_VERSION_ONLY])),
      jpeg.subarray(2)
    ]);

    const { output, gainMaps } = stripMetadataLosslessly(announced, 'jpeg');

    expect(gainMaps).toEqual({
      kind: 'dropped',
      reason: 'No usable gain map image found'
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(output).toEqual(stripMetadataLosslessly(jpeg, 'jpeg').output);
  });

  it('drops MPF previews of an SDR photo silently, as before', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const fixture = await identifyingUltraHdrJpeg();
    const sdr = stripMetadataLosslessly(fixture.jpeg, 'jpeg', {
      gainMaps: 'drop'
    }).output;
    const preview = fixture.dropped[1];
    // An SDR primary whose only secondary image is an MPF large thumbnail.
    const mpfTiff = Buffer.alloc(8 + 2 + 2 * 12 + 4 + 32);
    mpfTiff.write('MM\0*', 0, 'latin1');
    mpfTiff.writeUInt32BE(8, 4);
    mpfTiff.writeUInt16BE(2, 8);
    mpfTiff.writeUInt16BE(0xb001, 10);
    mpfTiff.writeUInt16BE(4, 12);
    mpfTiff.writeUInt32BE(1, 14);
    mpfTiff.writeUInt32BE(2, 18);
    mpfTiff.writeUInt16BE(0xb002, 22);
    mpfTiff.writeUInt16BE(7, 24);
    mpfTiff.writeUInt32BE(32, 26);
    mpfTiff.writeUInt32BE(38, 30);
    const segment = jpegSegment(
      0xe2,
      Buffer.concat([Buffer.from('MPF\0'), mpfTiff])
    );
    const primaryLength = sdr.length + segment.length;
    mpfTiff.writeUInt32BE(MPF_PRIMARY_TYPE, 38);
    mpfTiff.writeUInt32BE(primaryLength, 42);
    mpfTiff.writeUInt32BE(MPF_LARGE_THUMBNAIL_TYPE, 54);
    mpfTiff.writeUInt32BE(preview.length, 58);
    mpfTiff.writeUInt32BE(primaryLength - 10, 62);
    const withPreview = Buffer.concat([
      sdr.subarray(0, 2),
      jpegSegment(0xe2, Buffer.concat([Buffer.from('MPF\0'), mpfTiff])),
      sdr.subarray(2),
      preview
    ]);

    const { output, input, gainMaps } = stripMetadataLosslessly(
      withPreview,
      'jpeg'
    );

    expect(gainMaps).toBeUndefined();
    expect(input.metadataBlocks).toEqual(['APP2:MPF', 'trailing-data']);
    expect(output).toEqual(sdr);
    expect(warn).not.toHaveBeenCalled();
  });

  it('locates the gain map through the container directory alone', async () => {
    const fixture = await identifyingUltraHdrJpeg();
    const mpf = headerSegments(fixture.jpeg).find(
      (segment) => segment.payload.toString('latin1', 0, 4) === 'MPF\0'
    )!;
    const withoutMpf = Buffer.concat([
      fixture.jpeg.subarray(0, mpf.start),
      fixture.jpeg.subarray(mpf.start + 4 + mpf.payload.length)
    ]);

    const { output, gainMaps } = stripMetadataLosslessly(withoutMpf, 'jpeg');

    expect(gainMaps).toEqual({ kind: 'kept', count: 1 });
    expect(output.toString('latin1')).not.toContain('MPF\0');
    const xmp = payloadAfter(output, XMP_ID)!.toString('utf8');
    const length = Number(/Item:Length="(\d+)"/.exec(xmp)![1]);
    expect(xmp).toBe(primaryXmp(length));
    const gainMap = output.subarray(output.length - length);
    expect(gainMap.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(await pixelHash(gainMap)).toEqual(await pixelHash(fixture.gainMap));
    expect(await pixelHash(output)).toEqual(await pixelHash(fixture.jpeg));
    expectNoIdentifyingData(output, fixture.thumbnail);
    expectDropped(output, fixture.dropped);
  });

  it('never fails the strip because of a damaged gain map structure', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fixture = await identifyingUltraHdrJpeg();
    const sdr = stripMetadataLosslessly(fixture.jpeg, 'jpeg', {
      gainMaps: 'drop'
    }).output;
    const primaryDigest = describeImageContainer(
      fixture.jpeg,
      'jpeg'
    ).renderDigest;
    const segments = headerSegments(fixture.jpeg);
    const interior = (signature: string): [number, number] => {
      const segment = segments.find(
        (candidate) =>
          candidate.payload.toString('latin1', 0, signature.length) ===
          signature
      )!;
      const start = segment.start + 4 + signature.length;
      return [start, segment.start + 4 + segment.payload.length];
    };
    const regions = {
      mpf: interior('MPF\0'),
      xmp: interior(XMP_ID),
      secondary: [fixture.jpeg.indexOf(fixture.gainMap), fixture.jpeg.length]
    };
    const mutation = fc.record({
      region: fc.constantFrom<keyof typeof regions>('mpf', 'xmp', 'secondary'),
      position: fc.nat(),
      value: fc.integer({ min: 0, max: 255 })
    });

    fc.assert(
      fc.property(
        fc.array(mutation, { minLength: 1, maxLength: 6 }),
        (mutations) => {
          const damaged = Buffer.from(fixture.jpeg);
          for (const { region, position, value } of mutations) {
            const [start, end] = regions[region];
            damaged[start + (position % (end - start))] = value;
          }
          const result = stripMetadataLosslessly(damaged, 'jpeg');
          const after = describeImageContainer(result.output, 'jpeg');
          expect(after.metadataBlocks).toEqual([]);
          expect(after.renderDigest).toBe(primaryDigest);
          if (result.gainMaps?.kind !== 'kept') {
            expect(result.output).toEqual(sdr);
          }
        }
      ),
      { numRuns: 150 }
    );
  });
});

describe('stripMetadataLosslessly: Apple HDR gain maps', () => {
  it.each([
    ['without', false],
    ['with', true]
  ])(
    'keeps the gain map %s ISO 21496-1 metadata and drops the portrait matte',
    async (_, iso) => {
      const fixture = await identifyingAppleHdrJpeg({ iso });

      const { output, input, gainMaps } = stripMetadataLosslessly(
        fixture.jpeg,
        'jpeg'
      );

      expect(gainMaps).toEqual({ kind: 'kept', count: 1 });
      expect(input.metadataBlocks).toEqual([
        'APP1:Exif',
        'APP1:XMP',
        'APP2:MPF',
        'GainMap:APP1:Exif',
        'GainMap:APP1:XMP',
        'trailing-data'
      ]);
      expect(mpfIndex(output).entries.map((entry) => entry.attribute)).toEqual([
        MPF_REPRESENTATIVE | MPF_PRIMARY_TYPE,
        MPF_UNDEFINED_TYPE
      ]);
      const gainMap = gainMapViaMpf(output);
      // Nothing in the primary XMP was a gain map value, so it is gone.
      expect(payloadAfter(output, XMP_ID)).toBeUndefined();
      const gainMapXmp = payloadAfter(gainMap, XMP_ID)!.toString('utf8');
      expect(gainMapXmp).toBe(APPLE_GAIN_MAP_XMP);
      expectOnlyGainMapXmp(gainMapXmp);
      expect(payloadAfter(output, ISO_ID)).toEqual(
        iso ? ISO_VERSION_ONLY : undefined
      );
      expect(payloadAfter(gainMap, ISO_ID)).toEqual(
        iso ? isoGainMapMetadata() : undefined
      );
      if (iso) {
        expect((await Sharp(output).metadata()).gainMap?.image).toEqual(
          gainMap
        );
      }

      expect(await pixelHash(output)).toEqual(await pixelHash(fixture.jpeg));
      expect(await pixelHash(gainMap)).toEqual(
        await pixelHash(fixture.gainMap)
      );
      expectNoIdentifyingData(output, fixture.thumbnail);
      expectDropped(output, fixture.dropped);
      await expectCleanImageMetadata(output);
      await expectCleanImageMetadata(gainMap);
      expect(
        stripMetadataLosslessly(output, 'jpeg').input.metadataBlocks
      ).toEqual([]);
    }
  );
});

describe('stripMetadataWithPixelCheck: gain maps', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps a gain map whose decoded pixels match', async () => {
    const fixture = await identifyingUltraHdrJpeg();

    const outcome = await stripMetadataWithPixelCheck(fixture.jpeg, 'jpeg');

    expect(outcome).toEqual({
      kind: 'lossless',
      buffer: stripMetadataLosslessly(fixture.jpeg, 'jpeg').output,
      removed: expect.arrayContaining(['GainMap:APP1:Exif']),
      gainMaps: { kind: 'kept', count: 1 }
    });
  });

  it('drops a gain map whose decoded pixels differ and keeps the SDR base', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const fixture = await identifyingUltraHdrJpeg();
    const other = await Sharp({
      create: { width: 16, height: 8, channels: 3, background: '#808080' }
    })
      .jpeg()
      .toBuffer();
    const extract = lossless.extractJpegGainMaps;
    jest
      .spyOn(lossless, 'extractJpegGainMaps')
      .mockImplementation((image) =>
        image === fixture.jpeg ? extract(image) : [other]
      );

    const outcome = await stripMetadataWithPixelCheck(fixture.jpeg, 'jpeg');

    expect(outcome).toEqual({
      kind: 'lossless',
      buffer: stripMetadataLosslessly(fixture.jpeg, 'jpeg', {
        gainMaps: 'drop'
      }).output,
      removed: expect.any(Array),
      gainMaps: {
        kind: 'dropped',
        reason: expect.stringMatching(
          /^Gain map pixels did not verify: Decoded gain map \w+ changed after stripping$/
        )
      }
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Gain map pixels did not verify')
    );
  });
});
