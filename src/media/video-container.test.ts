import fc from 'fast-check';
import {
  detectStorableVideoContentType,
  videoExtensionForContentType
} from './video-container';

function ftyp(major: string, ...compatible: string[]): Buffer {
  const brands = [major, '\0\0\0\0', ...compatible].join('');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + brands.length);
  return Buffer.concat([
    size,
    Buffer.from('ftyp'),
    Buffer.from(brands, 'latin1'),
    Buffer.alloc(16)
  ]);
}

function ebml(docType: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, docType.length]),
    Buffer.from(docType),
    Buffer.alloc(16)
  ]);
}

describe('detectStorableVideoContentType', () => {
  it.each([
    [ftyp('isom', 'isom', 'mp42'), 'video/mp4'],
    [ftyp('mp42', 'mp41'), 'video/mp4'],
    [ftyp('M4V ', 'M4V '), 'video/mp4'],
    [ftyp('qt  ', 'qt  '), 'video/quicktime'],
    [ebml('webm'), 'video/webm'],
    [
      Buffer.concat([Buffer.from('00000008', 'hex'), Buffer.from('wide')]),
      'video/quicktime'
    ]
  ])('detects %#', (bytes, expected) => {
    expect(detectStorableVideoContentType(bytes)).toBe(expected);
  });

  it.each([
    ['matroska', ebml('matroska')],
    ['avif image', ftyp('avif', 'avif', 'mif1', 'miaf')],
    ['heic image', ftyp('heic', 'mif1', 'heic')],
    ['3gp', ftyp('3gp4', '3gp4')],
    ['avi', Buffer.from('RIFF\0\0\0\0AVI LIST')],
    ['html', Buffer.from('<!doctype html><html></html>')],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')],
    ['empty', Buffer.alloc(0)],
    ['short', Buffer.from([0x1a, 0x45])]
  ])('rejects %s', (_name, bytes) => {
    expect(detectStorableVideoContentType(bytes)).toBeNull();
  });

  it('only ever answers with an allowlisted type', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 128 }), (array) => {
        const result = detectStorableVideoContentType(Buffer.from(array));
        expect([null, 'video/mp4', 'video/webm', 'video/quicktime']).toContain(
          result
        );
      })
    );
  });
});

describe('videoExtensionForContentType', () => {
  it.each([
    ['video/mp4', 'mp4'],
    ['video/webm', 'webm'],
    ['video/quicktime', 'mov']
  ] as const)('maps %s to .%s', (type, extension) => {
    expect(videoExtensionForContentType(type)).toBe(extension);
  });
});
