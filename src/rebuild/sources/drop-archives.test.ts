import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  checkDropArchiveIndex,
  dropArchiveRoot,
  importAnswerFileHashes,
  keccakHex,
  waveIdOf,
  wavesFileDropArchiveRoot
} from '@/rebuild/sources/drop-archives';

// Made-up vectors from the snapshot tool's own encoder, not from the code
// that reads the archives: no real data.
const FIXTURES = path.join(__dirname, 'fixtures', 'drop-archives');
type Index = {
  dropArchiveRoot: string;
  archives: {
    waveId: string;
    legacyWave: string;
    file: string;
    bytes: number;
    hash: string;
  }[];
};
const indexOf = (n: number) =>
  JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `index-${n}.json`), 'utf8')
  ) as Index;

/** A Waves v1 file's first 128 bytes with `root` as its dropArchiveRoot. */
function wavesFile(root: string, schema = 0x411d, version = 1): Buffer {
  const bytes = Buffer.alloc(160, 7);
  bytes.writeUInt16BE(schema, 0);
  bytes.writeUInt16BE(version, 2);
  Buffer.from(root, 'hex').copy(bytes, 96);
  return bytes;
}

describe('drop archive root', () => {
  it('matches the vectors: empty, one, two, and three archives', () => {
    expect(dropArchiveRoot([])).toBe(
      '84ca4db130103e58aaab98a75266cf87f8c1b8a21ef3d3201b963ed829d4227a'
    );
    for (const n of [0, 1, 2, 3]) {
      const index = indexOf(n);
      expect(dropArchiveRoot(index.archives)).toBe(index.dropArchiveRoot);
    }
    // Three archives: the odd last leaf goes up unchanged.
    expect(indexOf(3).dropArchiveRoot).toBe(
      '91bef2950112714cb6dcdbce691e5b40a53a97214a46f2cc8929fbdc36f8904a'
    );
  });

  it("hashes each archive's bytes with Keccak-256, and derives each wave id", () => {
    for (const archive of indexOf(3).archives) {
      expect(
        keccakHex(fs.readFileSync(path.join(FIXTURES, archive.file)))
      ).toBe(archive.hash);
      expect(waveIdOf(archive.legacyWave)).toBe(archive.waveId);
    }
    for (const bad of [
      'not-a-uuid',
      '2222222222224222822200000000000-1',
      '22222222-2222-4222-8222-00000000000A'
    ]) {
      expect(() => waveIdOf(bad)).toThrow('is not a lowercase UUID');
    }
  });

  it('refuses the wrong order, a wave twice, and fields that are not 64 lowercase hex', () => {
    const [a, b] = indexOf(2).archives;
    expect(() => dropArchiveRoot([b, a])).toThrow(
      'waveIds must be strictly ascending'
    );
    expect(() => dropArchiveRoot([a, a])).toThrow(
      'waveIds must be strictly ascending'
    );
    expect(() =>
      dropArchiveRoot([{ ...a, hash: a.hash.toUpperCase() }])
    ).toThrow('64 lowercase hex digits');
  });

  it("reads a Waves v1 file's root, and nothing from another file", () => {
    const root = indexOf(3).dropArchiveRoot;
    expect(wavesFileDropArchiveRoot(wavesFile(root))).toBe(root);
    expect(wavesFileDropArchiveRoot(wavesFile(root, 0x4120))).toBeNull();
    expect(wavesFileDropArchiveRoot(wavesFile(root, 0x411d, 2))).toBeNull();
    expect(wavesFileDropArchiveRoot(Buffer.alloc(127))).toBeNull();
  });

  it("takes the Waves v1 file hashes from the chain's recorded import answers, by key", () => {
    const answer = (
      key: string,
      data: Record<string, unknown>,
      status = 200
    ) => ({ key, status, body: JSON.stringify({ data }) });
    const get = (query: string) =>
      `GET /v1/waves/import${query} ${'e3'.repeat(32)}`;
    const done = (fileHash: unknown) => ({ completed: true, fileHash });
    const [a, b] = ['cd'.repeat(32), 'ab'.repeat(32)];
    expect(
      importAnswerFileHashes([
        // Two networks' answers: both are named.
        answer(get('?height=1&network=0x01'), done(`0x${a}`)),
        answer(get('?height=1&network=0x02'), done(`0x${b}`)),
        // The same hash again, and mixed case, read once.
        answer(get(''), done(`0x${a.toUpperCase()}`)),
        // Not counted: another route's key (whatever its path says), a
        // POST, an import not completed, another status, not a hash.
        answer(
          `GET /v1/elsewhere ${'e3'.repeat(32)}`,
          done(`0x${'ef'.repeat(32)}`)
        ),
        answer(`POST /v1/waves/import {}`, done(`0x${'ef'.repeat(32)}`)),
        answer(get(''), { completed: false, fileHash: `0x${'ef'.repeat(32)}` }),
        answer(get(''), done(`0x${'ef'.repeat(32)}`), 404),
        answer(get(''), done('ef'.repeat(32))),
        { key: get(''), status: 200, body: 'not json' }
      ])
    ).toEqual([b, a]);
  });

  describe('an index against the root of the Waves v1 file the chain names', () => {
    const index = indexOf(3);
    const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
    const roots = [index.dropArchiveRoot];

    it('attests the archives, with their listed sizes, when its root is the chain root', () => {
      const checked = checkDropArchiveIndex(bytes(index), [
        '00'.repeat(32),
        index.dropArchiveRoot
      ]);
      expect(checked.problems).toEqual([]);
      expect(checked.waiting).toBeNull();
      expect(Array.from(checked.archives.entries()).sort()).toEqual(
        index.archives.map((a) => [a.hash, a.bytes]).sort()
      );
    });

    it('takes an empty index against the empty root', () => {
      expect(
        checkDropArchiveIndex(bytes(indexOf(0)), [dropArchiveRoot([])])
      ).toEqual({
        archives: new Map(),
        waves: new Map(),
        problems: [],
        waiting: null
      });
    });

    it('waits, without failing, when no Waves v1 file the chain names is served', () => {
      const checked = checkDropArchiveIndex(bytes(index), []);
      expect(checked.problems).toEqual([]);
      expect(checked.archives.size).toBe(0);
      expect(checked.waiting).toMatch(
        /^no Waves v1 file the chain names .* so the drop archive index can't be checked against the chain$/
      );
    });

    it('refuses a tampered pair, the wrong order and a wave twice, attesting nothing', () => {
      const archives = (list: Index['archives']) => ({
        archives: list
      });
      const tampered = archives(
        index.archives.map((a, i) =>
          i === 1 ? { ...a, hash: 'f'.repeat(64) } : a
        )
      );
      const tamperedCheck = checkDropArchiveIndex(bytes(tampered), roots);
      expect(tamperedCheck.archives.size).toBe(0);
      expect(tamperedCheck.problems).toEqual([
        expect.stringMatching(
          /^the drop archive index's root [0-9a-f]{64} is not the dropArchiveRoot of the Waves v1 file the chain names$/
        )
      ]);
      for (const bad of [
        archives([index.archives[1], index.archives[0], index.archives[2]]),
        archives([index.archives[0], ...index.archives])
      ]) {
        const checked = checkDropArchiveIndex(bytes(bad), roots);
        expect(checked.archives.size).toBe(0);
        expect(checked.problems).toEqual([
          expect.stringContaining('waveIds must be strictly ascending')
        ]);
      }
    });

    it("refuses its own root that isn't its pairs' root, a rebound or missing UUID, and non-strings", () => {
      expect(
        checkDropArchiveIndex(
          bytes({ ...index, dropArchiveRoot: '00'.repeat(32) }),
          roots
        ).problems
      ).toEqual([
        `the drop archive index gives dropArchiveRoot ${'00'.repeat(32)}, but its archives' root is ${index.dropArchiveRoot}`
      ]);
      const rebound = {
        ...index,
        archives: index.archives.map((a, i) =>
          i === 0
            ? { ...a, legacyWave: '22222222-2222-4222-8222-000000000009' }
            : a
        )
      };
      expect(checkDropArchiveIndex(bytes(rebound), roots).problems).toEqual([
        expect.stringMatching(
          /^the drop archive index lists wave [0-9a-f]{64} for 22222222-2222-4222-8222-000000000009, whose wave id is [0-9a-f]{64}$/
        )
      ]);
      const missing = {
        ...index,
        archives: index.archives.map((a, i) => {
          if (i !== 2) return a;
          const { legacyWave: _, ...rest } = a;
          return rest;
        })
      };
      expect(checkDropArchiveIndex(bytes(missing), roots).problems).toEqual([
        "the drop archive index's archive 3 lacks a waveId, hash or legacyWave string"
      ]);
      const sized = {
        archives: [{ ...index.archives[0], bytes: 1.5 }]
      };
      expect(checkDropArchiveIndex(bytes(sized), roots).problems).toEqual([
        "the drop archive index's archive 1 gives a size that isn't a whole number of bytes"
      ]);
      const numeric = {
        archives: [{ ...index.archives[0], hash: 1 }]
      };
      expect(checkDropArchiveIndex(bytes(numeric), roots).problems).toEqual([
        "the drop archive index's archive 1 lacks a waveId, hash or legacyWave string"
      ]);
      expect(
        checkDropArchiveIndex(Buffer.from('not json'), roots).problems
      ).toEqual(['the drop archive index is not JSON']);
    });
  });
});
