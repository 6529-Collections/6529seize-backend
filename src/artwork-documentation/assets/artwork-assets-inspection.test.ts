import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  hashAssetStream,
  inspectAssetHeader
} from '@/artwork-documentation/assets/artwork-assets.inspection';

describe('archive fixity and bounded inspection', () => {
  it('preserves exact bytes and detects a truncated or oversized stream', async () => {
    const bytes = Buffer.from([0, 255, 8, 13, 10, 129, 0]);
    const result = await hashAssetStream(
      Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
      bytes.length,
      'dng',
      new AbortController().signal
    );
    expect(result.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex')
    );
    await expect(
      hashAssetStream(
        Readable.from([bytes]),
        bytes.length + 1,
        'dng',
        new AbortController().signal
      )
    ).rejects.toThrow('UPLOAD_SIZE_MISMATCH');
    await expect(
      hashAssetStream(
        Readable.from([bytes]),
        bytes.length - 1,
        'dng',
        new AbortController().signal
      )
    ).rejects.toThrow('UPLOAD_SIZE_MISMATCH');
  });
  it('streams a full 4GiB fixture through a 64KiB inspection prefix', async () => {
    const chunk = Buffer.alloc(4 * 1024 * 1024, 97);
    const expected = createHash('sha256');
    function* chunks() {
      for (let index = 0; index < 1024; index++) {
        expected.update(chunk);
        yield chunk;
      }
    }
    const result = await hashAssetStream(
      Readable.from(chunks()),
      4 * 1024 ** 3,
      'tiff',
      new AbortController().signal
    );
    expect(result.size).toBe(4 * 1024 ** 3);
    expect(result.prefix).toHaveLength(64 * 1024);
    expect(result.sha256).toBe(expected.digest('hex'));
  }, 60000);
  it('validates split UTF8 and rejects invalid text or XMP external entities', async () => {
    const bytes = Buffer.from('মুক্তিযুদ্ধ');
    await expect(
      hashAssetStream(
        Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]),
        bytes.length,
        'txt',
        new AbortController().signal
      )
    ).resolves.toMatchObject({ size: bytes.length });
    await expect(
      hashAssetStream(
        Readable.from([Buffer.from([0xff])]),
        1,
        'txt',
        new AbortController().signal
      )
    ).rejects.toThrow('INVALID_TEXT_ENCODING');
    const xml = [
      Buffer.from('<?xml?><!DOC'),
      Buffer.from('TYPE x [<!ENTITY x SYSTEM "https://invalid">]>')
    ];
    await expect(
      hashAssetStream(
        Readable.from(xml),
        xml.reduce((sum, part) => sum + part.length, 0),
        'xmp',
        new AbortController().signal
      )
    ).rejects.toThrow('UNSAFE_XML_DECLARATION');
  });
  it('rejects MIME spoofing while reporting vendor RAW inspection honestly', () => {
    expect(() => inspectAssetHeader(Buffer.from('<svg/>'), 'png')).toThrow(
      'FILE_SIGNATURE_MISMATCH'
    );
    expect(inspectAssetHeader(Buffer.from('II*\0xxxxxxxx'), 'nef')).toEqual({
      detected_mime: 'image/x-nikon-nef',
      inspection_status: 'unsupported'
    });
    expect(() =>
      inspectAssetHeader(Buffer.from('II*\0xxxxxxxx'), 'cr2')
    ).toThrow('FILE_SIGNATURE_MISMATCH');
  });
});
