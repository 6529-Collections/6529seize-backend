import { characterizeTiff } from './artwork-assets.tiff';

function tiff(big: boolean, ifdOffset = big ? 16 : 8) {
  const tags = [
    [256, 3, 14204],
    [257, 3, 9472],
    [258, 3, 16],
    [277, 3, 3]
  ];
  const countSize = big ? 8 : 2;
  const entrySize = big ? 20 : 12;
  const directory = Buffer.alloc(
    countSize + tags.length * entrySize + (big ? 8 : 4)
  );
  if (big) directory.writeUInt32LE(tags.length);
  else directory.writeUInt16LE(tags.length);
  tags.forEach(([tag, type, value], index) => {
    const offset = countSize + index * entrySize;
    directory.writeUInt16LE(tag, offset);
    directory.writeUInt16LE(type, offset + 2);
    directory.writeUInt32LE(1, offset + 4);
    directory.writeUInt16LE(value, offset + (big ? 12 : 8));
  });
  const header = Buffer.alloc(big ? 16 : 8);
  header.write('II');
  header.writeUInt16LE(big ? 43 : 42, 2);
  if (big) {
    header.writeUInt16LE(8, 4);
    header.writeUInt32LE(ifdOffset % 2 ** 32, 8);
    header.writeUInt32LE(Math.floor(ifdOffset / 2 ** 32), 12);
  } else header.writeUInt32LE(ifdOffset, 4);
  const size = ifdOffset + directory.length;
  const read = jest.fn(async (start: number, length: number) => {
    if (start < header.length) return header.subarray(start, start + length);
    return directory.subarray(start - ifdOffset, start - ifdOffset + length);
  });
  return { header, directory, read, size };
}

describe('bounded TIFF measurements', () => {
  it.each([false, true])(
    'reads 134.5MP 16-bit RGB directory values without allocating pixels (BigTIFF %s)',
    async (big) => {
      const fixture = tiff(big, big ? 5 * 1024 ** 3 : 8);
      const result = await characterizeTiff(fixture.size, fixture.read);
      expect(result).toMatchObject({
        width: 14204,
        height: 9472,
        bit_depth: 16,
        channels: 3,
        tiff_characterization_scope: 'first_image_directory'
      });
      expect(
        fixture.read.mock.calls.reduce((total, [, bytes]) => total + bytes, 0)
      ).toBeLessThan(256);
      if (big) expect(fixture.read).toHaveBeenCalledWith(5 * 1024 ** 3, 8);
    }
  );
  it('rejects an out-of-bounds IFD and unsupported BigTIFF pointer widths', async () => {
    const fixture = tiff(true);
    fixture.header.writeUInt32LE(0xffffffff, 8);
    await expect(characterizeTiff(fixture.size, fixture.read)).rejects.toThrow(
      'INVALID_TIFF_DIRECTORY'
    );
    const unsupportedWidth = tiff(true);
    unsupportedWidth.header.writeUInt16LE(16, 4);
    await expect(
      characterizeTiff(unsupportedWidth.size, unsupportedWidth.read)
    ).rejects.toThrow('INVALID_TIFF_DIRECTORY');
    expect(unsupportedWidth.read).toHaveBeenCalledTimes(1);
  });
  it('does not allocate attacker-declared unbounded directory sizes', async () => {
    const fixture = tiff(true);
    fixture.directory.writeUInt32LE(100000);
    await expect(
      characterizeTiff(fixture.size, fixture.read)
    ).resolves.toBeNull();
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });
});
