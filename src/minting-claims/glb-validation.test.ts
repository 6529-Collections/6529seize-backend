import fc from 'fast-check';
import { BadRequestException } from '@/exceptions';
import { assertValidGlb } from '@/minting-claims/glb-validation';
import {
  validGlb,
  glbChunk,
  glbFromChunks,
  JSON_CHUNK_TYPE,
  BIN_CHUNK_TYPE
} from '@/tests/fixtures/glb';

const jsonChunk = () =>
  glbChunk(JSON_CHUNK_TYPE, Buffer.from('{"asset":{"version":"2.0"}}'));

describe('GLB container validation', () => {
  it('accepts JSON-only GLB and external resources without fetching them', () => {
    expect(() => assertValidGlb(validGlb())).not.toThrow();
    expect(() =>
      assertValidGlb(
        validGlb({
          asset: { version: '2.0' },
          buffers: [{ uri: 'scene.bin', byteLength: 4 }]
        })
      )
    ).not.toThrow();
  });

  it.each([1, 2, 3, 4])(
    'accepts aligned BIN padding for %i bytes',
    (length) => {
      assertValidGlb(
        validGlb(
          { asset: { version: '2.0' }, buffers: [{ byteLength: length }] },
          Buffer.alloc(length, 7)
        )
      );
    }
  );

  it('ignores unknown extension chunks after the standard chunks', () => {
    assertValidGlb(
      glbFromChunks([
        jsonChunk(),
        glbChunk(BIN_CHUNK_TYPE, Buffer.alloc(4)),
        glbChunk(0x12345678, Buffer.alloc(4))
      ])
    );
    assertValidGlb(
      glbFromChunks([jsonChunk(), glbChunk(0x12345678, Buffer.alloc(0))])
    );
  });

  it.each([
    ['magic', 0, 0],
    ['container version', 4, 1],
    ['declared length', 8, 12],
    ['chunk alignment', 12, 3],
    ['chunk bounds', 12, 0xfffffffc],
    ['first chunk type', 16, BIN_CHUNK_TYPE]
  ])('rejects invalid %s', (_name, offset, value) => {
    const buffer = validGlb();
    buffer.writeUInt32LE(value, offset);
    expect(() => assertValidGlb(buffer)).toThrow(BadRequestException);
  });

  it.each([
    ['header only', () => glbFromChunks([])],
    ['renamed text', () => Buffer.from('this is not a binary glTF file')],
    [
      'truncated chunk header',
      () => glbFromChunks([jsonChunk(), Buffer.alloc(4)])
    ],
    ['duplicate JSON', () => glbFromChunks([jsonChunk(), jsonChunk()])],
    [
      'duplicate BIN',
      () =>
        glbFromChunks([
          jsonChunk(),
          glbChunk(BIN_CHUNK_TYPE, Buffer.alloc(4)),
          glbChunk(BIN_CHUNK_TYPE, Buffer.alloc(4))
        ])
    ],
    [
      'misplaced BIN',
      () =>
        glbFromChunks([
          jsonChunk(),
          glbChunk(42, Buffer.alloc(4)),
          glbChunk(BIN_CHUNK_TYPE, Buffer.alloc(4))
        ])
    ],
    [
      'invalid JSON',
      () => glbFromChunks([glbChunk(JSON_CHUNK_TYPE, Buffer.from('{bad'))])
    ],
    [
      'invalid UTF-8',
      () =>
        glbFromChunks([
          glbChunk(JSON_CHUNK_TYPE, Buffer.from([0xff, 0xff, 0xff, 0xff]))
        ])
    ]
  ])('rejects %s', (_name, buffer) => {
    expect(() => assertValidGlb(buffer())).toThrow(BadRequestException);
  });

  it.each([
    null,
    [],
    {},
    { asset: [] },
    { asset: { version: '1.0' } },
    { asset: { version: '2.0', minVersion: '2.1' } },
    { asset: { version: '2.0' }, buffers: [] },
    { asset: { version: '2.0' }, buffers: [null] },
    { asset: { version: '2.0' }, buffers: [{ byteLength: 0 }] },
    { asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }
  ])('rejects invalid JSON asset or missing BIN: %j', (json) => {
    expect(() => assertValidGlb(validGlb(json))).toThrow(BadRequestException);
  });

  it.each([1, 9])(
    'rejects BIN length mismatch for declared %i bytes',
    (length) => {
      const buffer = validGlb(
        { asset: { version: '2.0' }, buffers: [{ byteLength: length }] },
        Buffer.alloc(8)
      );
      expect(() => assertValidGlb(buffer)).toThrow('BIN chunk does not match');
    }
  );

  it('rejects nonzero BIN padding', () => {
    const buffer = validGlb(
      { asset: { version: '2.0' }, buffers: [{ byteLength: 1 }] },
      Buffer.alloc(1)
    );
    buffer[buffer.length - 1] = 1;
    expect(() => assertValidGlb(buffer)).toThrow('padding');
  });

  it('safely rejects every truncation of a valid GLB', () => {
    const buffer = validGlb();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: buffer.length - 1 }), (length) => {
        expect(() => assertValidGlb(buffer.subarray(0, length))).toThrow(
          BadRequestException
        );
      })
    );
  });
});
