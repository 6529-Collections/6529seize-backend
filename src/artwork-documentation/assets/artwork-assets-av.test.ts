import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { characterizeMp4 } from './artwork-assets.av';

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
});
