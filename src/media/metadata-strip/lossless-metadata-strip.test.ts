import { createHash } from 'node:crypto';
import fc from 'fast-check';
import Sharp from 'sharp';
import {
  describeImageContainer,
  LosslessStripFormat,
  LosslessStripUnsupported,
  stripMetadataLosslessly
} from './lossless-metadata-strip';
import { minimalOrientationTiff } from './exif-orientation';
import {
  animatedGifFixture,
  IDENTIFYING_STRINGS,
  identifyingGif,
  identifyingJpeg,
  identifyingPng,
  identifyingWebp,
  pngChunk
} from './fixtures/identifying-image-fixtures';

async function orientedPixelHash(image: Buffer, animated = false) {
  const { data, info } = await Sharp(image, { animated })
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    hash: createHash('sha256').update(data).digest('hex')
  };
}

function expectNoIdentifyingStrings(image: Buffer) {
  const text = image.toString('latin1');
  for (const value of IDENTIFYING_STRINGS) {
    expect(text).not.toContain(value);
  }
  expect(text).not.toContain('Exif\0\0II');
  expect(text).not.toContain('x:xmpmeta');
  expect(text).not.toContain('Photoshop 3.0');
}

function pngChunks(png: Buffer): { type: string; bytes: Buffer }[] {
  const chunks: { type: string; bytes: Buffer }[] = [];
  let position = 8;
  while (position < png.length) {
    const length = png.readUInt32BE(position);
    chunks.push({
      type: png.toString('latin1', position + 4, position + 8),
      bytes: png.subarray(position, position + 12 + length)
    });
    position += 12 + length;
  }
  return chunks;
}

function webpChunks(webp: Buffer): { fourcc: string; data: Buffer }[] {
  const chunks: { fourcc: string; data: Buffer }[] = [];
  let position = 12;
  while (position < webp.length) {
    const size = webp.readUInt32LE(position + 4);
    chunks.push({
      fourcc: webp.toString('latin1', position, position + 4),
      data: webp.subarray(position + 8, position + 8 + size)
    });
    position += 8 + size + (size % 2);
  }
  return chunks;
}

describe('stripMetadataLosslessly: JPEG', () => {
  it('removes every identifying block and keeps pixels, ICC and orientation', async () => {
    const { jpeg, thumbnail } = await identifyingJpeg();
    const before = await Sharp(jpeg).metadata();
    expect(before).toMatchObject({ orientation: 6, isProgressive: true });
    expect(before.icc).toBeDefined();

    const { output, input } = stripMetadataLosslessly(jpeg, 'jpeg');

    expect(input.metadataBlocks).toEqual([
      'APP0:JFIF-thumbnail',
      'APP1:Exif',
      'APP1:XMP',
      'APP13',
      'COM',
      'COM',
      'trailing-data'
    ]);
    expectNoIdentifyingStrings(output);
    expect(output.indexOf(thumbnail)).toBe(-1);
    expect(output.toString('latin1')).not.toContain('THUMB1');

    const after = await Sharp(output).metadata();
    expect(after.icc).toEqual(before.icc);
    // The profile description is UTF-16: "Display P3".
    expect(after.icc!.indexOf(Buffer.from([0, 0x50, 0, 0x33]))).toBeGreaterThan(
      0
    );
    expect(after.orientation).toBe(6);
    expect(after.exif).toEqual(
      Buffer.concat([Buffer.from('Exif\0\0'), minimalOrientationTiff(6)])
    );
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(after.comments).toBeUndefined();
    expect(after.isProgressive).toBe(true);

    const pixels = await orientedPixelHash(output);
    expect(pixels).toEqual(await orientedPixelHash(jpeg));
    expect(pixels).toMatchObject({ width: 16, height: 32 });
  });

  it('keeps every ICC chunk and the Adobe marker byte for byte, in order', async () => {
    const { jpeg } = await identifyingJpeg();
    const { output } = stripMetadataLosslessly(jpeg, 'jpeg');
    const iccSegment = (image: Buffer) => {
      const start = image.indexOf(Buffer.from('ICC_PROFILE\0')) - 4;
      return image.subarray(start, start + 2 + image.readUInt16BE(start + 2));
    };
    expect(iccSegment(output)).toEqual(iccSegment(jpeg));

    const adobe = Buffer.from([
      0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00,
      0x00, 0x00, 0x00, 0x01
    ]);
    const withAdobe = Buffer.concat([
      output.subarray(0, 2),
      adobe,
      output.subarray(2)
    ]);
    const restripped = stripMetadataLosslessly(withAdobe, 'jpeg').output;
    expect(restripped.indexOf(adobe)).toBe(2);
  });

  it('drops EXIF entirely when the image is already upright', async () => {
    const base = await Sharp({
      create: { width: 6, height: 4, channels: 3, background: '#204060' }
    })
      .jpeg()
      .withExif({ IFD0: { Make: 'SynthCam Make', Orientation: '1' } })
      .toBuffer();
    const { output } = stripMetadataLosslessly(base, 'jpeg');
    const metadata = await Sharp(output).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('is idempotent once metadata is gone', async () => {
    const { jpeg } = await identifyingJpeg();
    const once = stripMetadataLosslessly(jpeg, 'jpeg').output;
    const twice = stripMetadataLosslessly(once, 'jpeg');
    expect(twice.output).toEqual(once);
    expect(twice.input.metadataBlocks).toEqual([]);
  });

  it('removes arbitrary comment and application segments without touching the image', async () => {
    const { jpeg } = await identifyingJpeg();
    const clean = stripMetadataLosslessly(jpeg, 'jpeg').output;
    const segment = fc
      .record({
        marker: fc.constantFrom(
          0xe1,
          0xe3,
          0xe4,
          0xe9,
          0xeb,
          0xec,
          0xed,
          0xef,
          0xfe
        ),
        payload: fc.uint8Array({ minLength: 0, maxLength: 300 })
      })
      .map(({ marker, payload }) => {
        const header = Buffer.from([0xff, marker, 0, 0]);
        header.writeUInt16BE(payload.length + 2, 2);
        return Buffer.concat([header, Buffer.from(payload)]);
      });
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 5 }), (segments) => {
        const noisy = Buffer.concat([
          clean.subarray(0, 2),
          ...segments,
          clean.subarray(2)
        ]);
        expect(stripMetadataLosslessly(noisy, 'jpeg').output).toEqual(clean);
      }),
      { numRuns: 50 }
    );
  });

  it.each([
    ['truncated before EOI', (jpeg: Buffer) => jpeg.subarray(0, -40)],
    ['not a JPEG', () => Buffer.from('GIF89a not a jpeg')],
    [
      'a segment that overruns the file',
      (jpeg: Buffer) =>
        Buffer.concat([
          jpeg.subarray(0, 2),
          Buffer.from([0xff, 0xe1, 0xff, 0xff])
        ])
    ]
  ])('refuses a JPEG that is %s', async (_, damage) => {
    const { jpeg } = await identifyingJpeg();
    expect(() => stripMetadataLosslessly(damage(jpeg), 'jpeg')).toThrow(
      LosslessStripUnsupported
    );
  });
});

describe('stripMetadataLosslessly: PNG', () => {
  it('removes text, time and EXIF chunks and keeps iCCP, orientation and pixels', async () => {
    const png = await identifyingPng();
    const { output, input } = stripMetadataLosslessly(png, 'png');

    expect(input.metadataBlocks).toEqual([
      'tEXt',
      'iTXt',
      'zTXt',
      'tIME',
      'eXIf',
      'tEXt'
    ]);
    expectNoIdentifyingStrings(output);
    const typesAfter = pngChunks(output).map((chunk) => chunk.type);
    expect(typesAfter).toEqual([
      'IHDR',
      'eXIf',
      'iCCP',
      'pHYs',
      'IDAT',
      'IEND'
    ]);
    const iccp = (image: Buffer) =>
      pngChunks(image).find((chunk) => chunk.type === 'iCCP')!.bytes;
    expect(iccp(output)).toEqual(iccp(png));

    const metadata = await Sharp(output).metadata();
    expect(metadata.orientation).toBe(6);
    expect(metadata.icc).toEqual((await Sharp(png).metadata()).icc);
    expect(await orientedPixelHash(output)).toEqual(
      await orientedPixelHash(png)
    );
  });

  it('keeps APNG animation chunks and drops private ancillary chunks', () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const animationControl = Buffer.alloc(8);
    animationControl.writeUInt32BE(1, 0);
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      pngChunk('IHDR', header),
      pngChunk('acTL', animationControl),
      pngChunk('iDOT', Buffer.alloc(28)),
      pngChunk('fcTL', Buffer.alloc(26)),
      pngChunk('IDAT', Buffer.from('78da636060f80f0001040100', 'hex')),
      pngChunk('fdAT', Buffer.alloc(8)),
      pngChunk('IEND', Buffer.alloc(0))
    ]);
    const { output } = stripMetadataLosslessly(png, 'png');
    expect(pngChunks(output).map((chunk) => chunk.type)).toEqual([
      'IHDR',
      'acTL',
      'fcTL',
      'IDAT',
      'fdAT',
      'IEND'
    ]);
  });

  it('refuses an unknown critical chunk it cannot safely drop', async () => {
    const png = await identifyingPng();
    const withCritical = Buffer.concat([
      png.subarray(0, 33),
      pngChunk('ZZZZ', Buffer.from('critical')),
      png.subarray(33)
    ]);
    expect(() => stripMetadataLosslessly(withCritical, 'png')).toThrow(
      'Unknown critical PNG chunk ZZZZ'
    );
  });
});

describe('stripMetadataLosslessly: WebP', () => {
  it('removes EXIF and XMP chunks, keeps ICCP and the whole animation', async () => {
    const webp = await identifyingWebp();
    expect(webpChunks(webp).map((chunk) => chunk.fourcc)).toEqual([
      'VP8X',
      'ICCP',
      'ANIM',
      'ANMF',
      'ANMF',
      'EXIF',
      'XMP '
    ]);
    const { output, input } = stripMetadataLosslessly(webp, 'webp');

    expect(input.metadataBlocks).toEqual(['EXIF', 'XMP']);
    expectNoIdentifyingStrings(output);
    const after = webpChunks(output);
    expect(after.map((chunk) => chunk.fourcc)).toEqual([
      'VP8X',
      'ICCP',
      'ANIM',
      'ANMF',
      'ANMF'
    ]);
    expect(after[1].data).toEqual(webpChunks(webp)[1].data);
    expect(after[0].data[0]).toBe(webpChunks(webp)[0].data[0] & ~0x0c);
    expect(output.readUInt32LE(4)).toBe(output.length - 8);

    const [before, metadata] = await Promise.all([
      Sharp(webp, { animated: true }).metadata(),
      Sharp(output, { animated: true }).metadata()
    ]);
    expect(metadata).toMatchObject({
      pages: 2,
      loop: before.loop,
      delay: before.delay,
      icc: before.icc
    });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(await orientedPixelHash(output, true)).toEqual(
      await orientedPixelHash(webp, true)
    );
  });

  it('keeps a signalled EXIF orientation as an orientation-only chunk', async () => {
    const webp = await Sharp({
      create: { width: 8, height: 4, channels: 3, background: '#406080' }
    })
      .webp({ lossless: true })
      .withMetadata({
        orientation: 6,
        exif: { IFD0: { Make: 'SynthCam Make' } }
      })
      .toBuffer();
    expect((await Sharp(webp).metadata()).orientation).toBe(6);
    const { output } = stripMetadataLosslessly(webp, 'webp');
    const exif = webpChunks(output).find((chunk) => chunk.fourcc === 'EXIF');
    expect(exif?.data).toEqual(minimalOrientationTiff(6));
    expect((await Sharp(output).metadata()).orientation).toBe(
      (await Sharp(webp).metadata()).orientation
    );
    expectNoIdentifyingStrings(output);
  });
});

describe('stripMetadataLosslessly: WebP padding', () => {
  it('accepts an odd final chunk without its pad byte and re-pads the output', async () => {
    const simple = await Sharp({
      create: { width: 5, height: 3, channels: 3, background: '#a05030' }
    })
      .webp({ lossless: true })
      .toBuffer();
    const junk = Buffer.concat([
      Buffer.from('JUNK'),
      Buffer.from([3, 0, 0, 0]),
      Buffer.from('abc')
    ]);
    const unpadded = Buffer.concat([simple, junk]);
    unpadded.writeUInt32LE(unpadded.length - 8, 4);

    const { output, input } = stripMetadataLosslessly(unpadded, 'webp');

    expect(input.metadataBlocks).toEqual(['JUNK']);
    expect(output).toEqual(simple);
    expect(await orientedPixelHash(output)).toEqual(
      await orientedPixelHash(simple)
    );
  });
});

describe('stripMetadataLosslessly: GIF', () => {
  it('removes comments, XMP and unknown applications, keeping frames and looping', async () => {
    const gif = identifyingGif();
    const { output, input } = stripMetadataLosslessly(gif, 'gif');

    expect(input.metadataBlocks).toEqual([
      'comment',
      'application:XMP DataXMP',
      'application:SYNTHAPP1.0',
      'comment'
    ]);
    expectNoIdentifyingStrings(output);
    expect(output).toEqual(animatedGifFixture());

    const metadata = await Sharp(output, { animated: true }).metadata();
    expect(metadata).toMatchObject({ pages: 2, loop: 2, delay: [80, 160] });
    expect(await orientedPixelHash(output, true)).toEqual(
      await orientedPixelHash(gif, true)
    );
  });

  it('drops data after the trailer', () => {
    const gif = animatedGifFixture();
    const trailing = Buffer.concat([
      gif,
      Buffer.from('SEFT-synthetic-trailer')
    ]);
    const { output, input } = stripMetadataLosslessly(trailing, 'gif');
    expect(input.metadataBlocks).toEqual(['trailing-data']);
    expect(output).toEqual(gif);
  });

  it('accepts a GIF that ends between blocks without a trailer', () => {
    const gif = animatedGifFixture();
    const { output } = stripMetadataLosslessly(gif.subarray(0, -1), 'gif');
    expect(output).toEqual(gif);
  });
});

describe('describeImageContainer', () => {
  it.each<[LosslessStripFormat, () => Promise<Buffer>]>([
    ['jpeg', async () => (await identifyingJpeg()).jpeg],
    ['png', identifyingPng],
    ['webp', identifyingWebp],
    ['gif', async () => identifyingGif()]
  ])(
    'reports the stored %s size from the container header',
    async (format, make) => {
      const image = await make();
      const description = describeImageContainer(image, format);
      const metadata = await Sharp(image).metadata();
      expect(description.width).toBe(metadata.width);
      expect(description.height).toBe(metadata.height);
    }
  );
});
