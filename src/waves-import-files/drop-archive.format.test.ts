import { relayWaveKey } from '@/wave-drop-index/relay-wave-key';
import { wavesFileCommitting } from '@/waves-import-files/drop-archive.build';
import {
  canonicalJson,
  dropArchiveRoot,
  keccak256Hex,
  legacyDerivedId,
  readWavesFileHeader,
  WAVE_KIND
} from '@/waves-import-files/drop-archive.format';

describe('the drop archive commitments', () => {
  it('hash with keccak-256', () => {
    expect(keccak256Hex(new Uint8Array())).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    );
  });

  it("derive a wave's chain id as the relays key it", () => {
    const wave = '00000000-0000-4000-8000-0000000000a2';
    expect(legacyDerivedId(wave, WAVE_KIND)).toBe(relayWaveKey(wave));
    expect(legacyDerivedId('not-a-uuid', WAVE_KIND)).toBeNull();
  });

  it('give the empty list the root the snapshot tooling gives it', () => {
    expect(dropArchiveRoot([])).toBe(
      '0x84ca4db130103e58aaab98a75266cf87f8c1b8a21ef3d3201b963ed829d4227a'
    );
  });

  it("read dropArchiveRoot from a Waves v1 file's header", () => {
    const root = `0x${'ab'.repeat(32)}`;
    const file = wavesFileCommitting(root, 1_795_000_000_000);
    expect(readWavesFileHeader(file)).toEqual({
      freezeMs: 1_795_000_000_000,
      docsRoot: `0x${'00'.repeat(32)}`,
      dropArchiveRoot: root
    });
  });

  it('refuse a file that is not a Waves v1 file', () => {
    const file = wavesFileCommitting(`0x${'ab'.repeat(32)}`);
    expect(() => readWavesFileHeader(file.subarray(0, 100))).toThrow(
      'at least'
    );
    const other = Buffer.from(file);
    other.writeUInt16BE(0x411c, 0);
    expect(() => readWavesFileHeader(other)).toThrow('Not a Waves v1 file');
  });
});

describe('canonical JSON', () => {
  it('sorts keys by code point, integer-like keys too', () => {
    expect(canonicalJson({ b: 1, a: [{ '2': true, '10': null }] })).toBe(
      '{"a":[{"10":null,"2":true}],"b":1}'
    );
  });

  it('holds integers only', () => {
    expect(() => canonicalJson({ a: 0.5 })).toThrow('integers only');
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });
});
