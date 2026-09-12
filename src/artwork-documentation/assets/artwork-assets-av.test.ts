import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { characterizeMp4 } from './artwork-assets.av';
import { validateMp4Tables } from './artwork-assets-mp4-budget';

function movieWithTable(type: string, payload: Buffer): Buffer {
  const box = (name: string, content: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(content.length + 8);
    header.write(name, 4);
    return Buffer.concat([header, content]);
  };
  let table = box(type, payload);
  for (const container of ['stbl', 'minf', 'mdia', 'trak', 'moov'])
    table = box(container, table);
  return Buffer.concat([box('ftyp', Buffer.from('isom0000')), table]);
}

describe('bounded audiovisual container characterization', () => {
  it('reads actual movie metadata from a fragmented MP4 without decoding media', async () => {
    const bytes = await readFile(join(__dirname, 'fixtures', 'dash-init.mp4'));
    const read = jest.fn(async (start: number, length: number) =>
      bytes.subarray(start, start + length)
    );
    const result = await characterizeMp4(bytes.length, read);
    expect(result).not.toBeNull();
    expect(result!.track_count).toBeGreaterThan(0);
    expect(result!.track_0_codec).toEqual(expect.any(String));
    expect(read.mock.calls.every(([, length]) => length <= 8 * 1024 ** 2)).toBe(
      true
    );
  });
  it('rejects a movie atom whose declared length overruns the source', async () => {
    const bytes = Buffer.alloc(16);
    bytes.writeUInt32BE(100);
    bytes.write('moov', 4);
    await expect(
      characterizeMp4(bytes.length, async (start, length) =>
        bytes.subarray(start, start + length)
      )
    ).rejects.toThrow('INVALID_MEDIA_CONTAINER');
  });

  it('rejects the reviewed 4765-byte sample-count inflation before MP4Box runs', async () => {
    const bytes = await readFile(join(__dirname, 'fixtures', 'dash-init.mp4'));
    const table = bytes.indexOf(Buffer.from('stsz'));
    expect(table).toBeGreaterThan(0);
    bytes.writeUInt32BE(1, table + 8);
    bytes.writeUInt32BE(250000, table + 12);
    await expect(
      characterizeMp4(bytes.length, async (start, length) =>
        bytes.subarray(start, start + length)
      )
    ).rejects.toThrow('INVALID_MEDIA_CONTAINER');
  });

  it('survives a child heap limit and can characterize the next clean movie', async () => {
    const clean = await readFile(join(__dirname, 'fixtures', 'dash-init.mp4'));
    const large = Buffer.from(clean);
    const table = large.indexOf(Buffer.from('stsz'));
    expect(table).toBeGreaterThan(0);
    large.writeUInt32BE(1, table + 8);
    large.writeUInt32BE(1000000, table + 12);
    // Model metadata from a larger original. Real bytes could back this count;
    // exhaustion must leave an honest large original available with partial metadata.
    const result = await characterizeMp4(8 * 1024 ** 3, async (start, length) =>
      large.subarray(start, start + length)
    );
    expect(result).toBeNull();
    const next = await characterizeMp4(clean.length, async (start, length) =>
      clean.subarray(start, start + length)
    );
    expect(next!.track_count).toBeGreaterThan(0);
  });

  it.each([250000, 1000000, 0xffffffff])(
    'rejects tiny constant-size tables declaring %s samples without expanding them',
    async (count) => {
      const table = Buffer.alloc(12);
      table.writeUInt32BE(1, 4);
      table.writeUInt32BE(count, 8);
      const bytes = movieWithTable('stsz', table);
      await expect(
        characterizeMp4(bytes.length, async (start, length) =>
          bytes.subarray(start, start + length)
        )
      ).rejects.toThrow('INVALID_MEDIA_CONTAINER');
      // No arbitrary sample-count limit: real media bytes may back a long work.
      expect(() =>
        validateMp4Tables(bytes, count + bytes.length)
      ).not.toThrow();
    }
  );

  it.each(['stts', 'ctts', 'stsc', 'stco', 'co64', 'stss'])(
    'rejects a truncated %s table before parsing',
    (type) => {
      const table = Buffer.alloc(8);
      table.writeUInt32BE(0xffffffff, 4);
      const bytes = movieWithTable(type, table);
      expect(() => validateMp4Tables(bytes, bytes.length)).toThrow(
        'INVALID_MEDIA_CONTAINER'
      );
    }
  );

  it('checks variable and compact sample tables against their encoded bytes', () => {
    const table = Buffer.alloc(12);
    table.writeUInt32BE(1000000, 8);
    expect(() => validateMp4Tables(movieWithTable('stsz', table), 8e9)).toThrow(
      'INVALID_MEDIA_CONTAINER'
    );
    table[7] = 4;
    expect(() => validateMp4Tables(movieWithTable('stz2', table), 8e9)).toThrow(
      'INVALID_MEDIA_CONTAINER'
    );
    table.writeUInt32BE(3, 8);
    expect(() =>
      validateMp4Tables(
        movieWithTable(
          'stz2',
          Buffer.concat([table, Buffer.from([0x12, 0x30])])
        ),
        1024
      )
    ).not.toThrow();
  });
});
