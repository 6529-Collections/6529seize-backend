import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { inspectArtworkArchive } from './artwork-assets.archive';

function checksum(bytes: Buffer): number {
  let value = -1;
  for (let index = 0; index < bytes.length; index++) {
    value ^= bytes[index];
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ -1) >>> 0;
}
function zip(
  files: {
    path: string;
    bytes: Buffer;
    deflated?: boolean;
    flags?: number;
    mode?: number;
  }[]
): Buffer {
  const data: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path);
    const bytes = file.deflated ? deflateRawSync(file.bytes) : file.bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.flags ?? 0, 6);
    local.writeUInt16LE(file.deflated ? 8 : 0, 8);
    local.writeUInt32LE(checksum(file.bytes), 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    local.copy(central, 6, 4, 26);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((file.mode ?? 0x81a4) * 65536) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    data.push(local, name, bytes);
    directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(
    directory.reduce((sum, bytes) => sum + bytes.length, 0),
    12
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, ...directory, end]);
}
function inspect(bytes: Buffer) {
  return inspectArtworkArchive(
    bytes.length,
    async (start, length) => bytes.subarray(start, start + length),
    async (start, length) =>
      Readable.from([bytes.subarray(start, start + length)]),
    new AbortController().signal
  );
}

describe('bounded museum package inspection', () => {
  it('inspects real stored and deflated members without executing source or changing names', async () => {
    const source = Buffer.from('globalThis.mustNeverExecute = true;');
    const description = Buffer.from('A documented package.');
    const result = await inspect(
      zip([
        { path: 'src/work.js', bytes: source, deflated: true },
        { path: 'README.txt', bytes: description }
      ])
    );
    expect(result).toMatchObject({
      entries: 2,
      expanded_bytes: source.length + description.length
    });
    expect(result.inventory[0]).toEqual({
      path: 'src/work.js',
      size_bytes: source.length,
      sha256: createHash('sha256').update(source).digest('hex')
    });
    expect(Reflect.get(globalThis, 'mustNeverExecute')).toBeUndefined();
  });
  it.each([
    '../outside.txt',
    '/absolute.txt',
    'C:/file.txt',
    'a\\b.txt',
    'a/../b.txt',
    'CON.txt',
    'a./file.txt'
  ])('rejects unsafe member path %s', async (path) => {
    await expect(
      inspect(zip([{ path, bytes: Buffer.from('hello') }]))
    ).rejects.toThrow('ARCHIVE_UNSAFE_PATH');
  });
  it('rejects case aliases and file/directory path conflicts', async () => {
    await expect(
      inspect(
        zip([
          { path: 'A.txt', bytes: Buffer.from('a') },
          { path: 'a.txt', bytes: Buffer.from('b') }
        ])
      )
    ).rejects.toThrow('ARCHIVE_DUPLICATE_PATH');
    await expect(
      inspect(
        zip([
          { path: 'a', bytes: Buffer.from('a') },
          { path: 'a/b.txt', bytes: Buffer.from('b') }
        ])
      )
    ).rejects.toThrow('ARCHIVE_PATH_CONFLICT');
  });
  it('rejects encrypted members, symbolic links and nested archives', async () => {
    await expect(
      inspect(zip([{ path: 'a.txt', bytes: Buffer.from('hello'), flags: 1 }]))
    ).rejects.toThrow('ARCHIVE_ENCRYPTED');
    await expect(
      inspect(
        zip([{ path: 'a.txt', bytes: Buffer.from('hello'), mode: 0xa1ff }])
      )
    ).rejects.toThrow('ARCHIVE_LINK_NOT_ALLOWED');
    await expect(
      inspect(
        zip([
          {
            path: 'renamed.bin',
            bytes: zip([{ path: 'a.txt', bytes: Buffer.from('hello') }])
          }
        ])
      )
    ).rejects.toThrow('ARCHIVE_NESTING_UNSUPPORTED');
  });
  it('rejects expanded output bounds and corrupted member bytes', async () => {
    await expect(
      inspect(
        zip([
          { path: 'bomb.txt', bytes: Buffer.alloc(100_000, 65), deflated: true }
        ])
      )
    ).rejects.toThrow('ARCHIVE_EXPANSION_LIMIT');
    const corrupted = zip([{ path: 'a.txt', bytes: Buffer.from('hello') }]);
    corrupted[35] ^= 1;
    await expect(inspect(corrupted)).rejects.toThrow('ARCHIVE_CRC_MISMATCH');
  });
  it('runs the same document and XML safety policy on archive members', async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    document.addJavaScript('blocked-action', 'app.alert("test");');
    const bytes = Buffer.from(await document.save());
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
    await expect(inspect(zip([{ path: 'unsafe.pdf', bytes }]))).rejects.toThrow(
      /blocked feature \/(JS|JavaScript)/
    );
    await expect(
      inspect(
        zip([
          {
            path: 'unsafe.svg',
            bytes: Buffer.from('<svg><!DOCTYPE svg></svg>')
          }
        ])
      )
    ).rejects.toThrow('UNSAFE_XML_DECLARATION');
  });
  it('preserves a PDF containing literal feature names inside a deflated archive', async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    document.setSubject('/JS /JavaScript /ObjStm');
    const bytes = Buffer.from(await document.save());
    const result = await inspect(
      zip([{ path: 'notes.pdf', bytes, deflated: true }])
    );
    expect(result.inventory).toEqual([
      {
        path: 'notes.pdf',
        size_bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    ]);
  });
  it('rejects mismatched local and central metadata and missing directory', async () => {
    const bytes = zip([{ path: 'a.txt', bytes: Buffer.from('hello') }]);
    const changed = Buffer.from(bytes);
    changed.writeUInt32LE(6, 22);
    await expect(inspect(changed)).rejects.toThrow(
      'ARCHIVE_LOCAL_HEADER_MISMATCH'
    );
    await expect(inspect(bytes.subarray(0, bytes.length - 1))).rejects.toThrow(
      'ARCHIVE_INVALID_DIRECTORY'
    );
  });
});
