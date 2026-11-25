import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dropArchiveRoot, keccakHex } from '@/rebuild/sources/drop-archives';
import { docsRoot } from '@/rebuild/sources/wave-docs';
import { exchangeKey } from '@/rebuild/sources/http-recording';
import { startSources, stopSources } from '@/rebuild/sources/start-sources';
import {
  base32Of,
  checkFiles,
  DOCS_INDEX,
  DROP_ARCHIVE_INDEX,
  FILE_INDEX,
  fileIdOf,
  namedKeccak256,
  namedSha256,
  startFileServer,
  WAVES_FILE
} from '@/rebuild/sources/file-server';
import { writeProvenance } from '@/rebuild/sources/running-source';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

/** RFC 4648 base32, lower case, no padding. */
function base32(bytes: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of Array.from(bytes)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

describe('file server', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-files-'));
    fs.writeFileSync(path.join(dir, 'bafyone'), 'one');
    fs.writeFileSync(path.join(dir, 'artwo'), 'two');
    fs.writeFileSync(
      path.join(dir, FILE_INDEX),
      JSON.stringify({ bafyone: sha256('one'), artwo: sha256('two') })
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the file id from every route form', () => {
    expect(fileIdOf('/ipfs/bafyone')).toBe('bafyone');
    expect(fileIdOf('/ipfs/bafyone/metadata.json')).toBe('bafyone');
    expect(fileIdOf('/ar/artwo')).toBe('artwo');
    expect(fileIdOf('/docs/bafyone?x=1')).toBe('bafyone');
    expect(fileIdOf('/bafyone')).toBe('bafyone');
    expect(fileIdOf('/../etc/passwd')).toBeNull();
  });

  it('reports files that miss the index, differ from it, or are missing', () => {
    expect(checkFiles(dir).problems).toEqual([]);
    fs.writeFileSync(path.join(dir, 'artwo'), 'changed');
    fs.writeFileSync(path.join(dir, 'extra'), 'x');
    fs.rmSync(path.join(dir, 'bafyone'));
    expect(checkFiles(dir).problems.sort((a, b) => a.localeCompare(b))).toEqual(
      [
        'artwo does not match its hash in files.json',
        'bafyone is in files.json but missing',
        'extra is not in files.json'
      ]
    );
  });

  it('serves the files seeds write, checked against their own index', async () => {
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-seed-'));
    try {
      const server = await startFileServer(dir, seedDir);
      try {
        // Written after the server started, as a seed writes them.
        fs.writeFileSync(path.join(seedDir, 'seg'), 'segment');
        fs.writeFileSync(path.join(seedDir, 'bad'), 'changed');
        fs.writeFileSync(
          path.join(seedDir, FILE_INDEX),
          JSON.stringify({ seg: sha256('segment'), bad: sha256('original') })
        );
        expect(await (await fetch(`${server.url}/bafyone`)).text()).toBe('one');
        expect(await (await fetch(`${server.url}/ipfs/seg`)).text()).toBe(
          'segment'
        );
        expect((await fetch(`${server.url}/bad`)).status).toBe(404);
        expect((await fetch(`${server.url}/bad`)).status).toBe(404);
        expect(server.problems()).toEqual([
          `files: seed file bad does not match its hash in ${FILE_INDEX}`,
          'files: 2 requests for files not in the directory, first /bad, /bad'
        ]);
        // An index a seed left half written is a problem, not a crash.
        fs.writeFileSync(path.join(seedDir, FILE_INDEX), '{"seg":');
        expect((await fetch(`${server.url}/seg`)).status).toBe(404);
        expect(server.problems()).toContain(
          `files: the seeds' ${FILE_INDEX} is not valid JSON`
        );
      } finally {
        await server.stop();
      }
    } finally {
      fs.rmSync(seedDir, { recursive: true, force: true });
    }
  });

  it('serves files by id and reports requests for others', async () => {
    const server = await startFileServer(dir);
    try {
      const one = await fetch(`${server.url}/ipfs/bafyone`);
      expect(await one.text()).toBe('one');
      expect((await fetch(`${server.url}/ar/nothing`)).status).toBe(404);
      expect(server.problems()).toEqual([
        'files: 1 requests for files not in the directory, first /ar/nothing'
      ]);
    } finally {
      await server.stop();
    }
  });

  describe('files named by their SHA-256', () => {
    const named = (text: string) => path.join(dir, sha256(text));
    beforeEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      fs.writeFileSync(named('one'), 'one');
      fs.writeFileSync(named('two'), 'two');
      fs.writeFileSync(
        path.join(dir, FILE_INDEX),
        JSON.stringify({
          [sha256('one')]: sha256('one'),
          [sha256('two')]: sha256('two')
        })
      );
    });

    it('counts a directory of only such files as verified', async () => {
      expect(checkFiles(dir)).toMatchObject({ problems: [], unverified: [] });
      const server = await startFileServer(dir);
      try {
        expect(server.info.provisional).toBe(false);
        expect(server.info.provisionalWhy).toBeUndefined();
        expect(
          await (await fetch(`${server.url}/${sha256('one')}`)).text()
        ).toBe('one');
      } finally {
        await server.stop();
      }
    });

    it('keeps a directory provisional for any other file, naming it', async () => {
      fs.writeFileSync(path.join(dir, 'bafyone'), 'one');
      fs.writeFileSync(
        path.join(dir, FILE_INDEX),
        JSON.stringify({
          [sha256('one')]: sha256('one'),
          [sha256('two')]: sha256('two'),
          bafyone: sha256('one')
        })
      );
      const server = await startFileServer(dir);
      try {
        expect(server.info).toMatchObject({
          provisional: true,
          provisionalWhy: 'ids not verified: bafyone'
        });
        expect(server.problems()).toEqual([]);
      } finally {
        await server.stop();
      }
    });

    it('takes a raw CIDv1 with a SHA-256 multihash as such a name', () => {
      // The CID of the bytes "one": 0x01 0x55 0x12 0x20 and the digest, base32.
      const cid = `b${base32(
        Buffer.concat([
          Buffer.from([0x01, 0x55, 0x12, 0x20]),
          Buffer.from(sha256('one'), 'hex')
        ])
      )}`;
      expect(cid.startsWith('bafkrei')).toBe(true);
      expect(namedSha256(cid)).toBe(sha256('one'));
      expect(namedSha256(sha256('one'))).toBe(sha256('one'));
      expect(namedSha256('bafyone')).toBeNull();
      // A published CID: SHA-256 of 'hello world'.
      expect(
        namedSha256(
          'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e'
        )
      ).toBe(sha256('hello world'));
      // The same with non-zero padding bits: not a canonical encoding.
      expect(
        namedSha256(
          'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5f'
        )
      ).toBeNull();
      // A dag-pb CIDv1 (0x70) names a node, not the file's bytes.
      expect(
        namedSha256(
          `b${base32(
            Buffer.concat([
              Buffer.from([0x01, 0x70, 0x12, 0x20]),
              Buffer.from(sha256('one'), 'hex')
            ])
          )}`
        )
      ).toBeNull();
      fs.writeFileSync(path.join(dir, cid), 'one');
      fs.writeFileSync(path.join(dir, 'bafkreiwrong'), 'x');
      const index = JSON.parse(
        fs.readFileSync(path.join(dir, FILE_INDEX), 'utf8')
      ) as Record<string, string>;
      fs.writeFileSync(
        path.join(dir, FILE_INDEX),
        JSON.stringify({
          ...index,
          [cid]: sha256('one'),
          bafkreiwrong: sha256('x')
        })
      );
      expect(checkFiles(dir)).toMatchObject({
        problems: [],
        unverified: ['bafkreiwrong']
      });
      fs.writeFileSync(path.join(dir, cid), 'two');
      expect(checkFiles(dir).problems).toContain(
        `${cid} is named by a SHA-256, but its bytes hash to ${sha256('two')}`
      );
    });

    it('fails on other bytes under a SHA-256 name, not just stays provisional', async () => {
      fs.writeFileSync(named('one'), 'not one');
      const server = await startFileServer(dir);
      try {
        expect(server.problems()).toEqual([
          `files: ${sha256('one')} is named by a SHA-256, but its bytes hash to ${sha256('not one')}`,
          `files: ${sha256('one')} does not match its hash in ${FILE_INDEX}`
        ]);
      } finally {
        await server.stop();
      }
    });
  });

  describe('files named by their Keccak-256', () => {
    // Made-up archives and their index (no real data), as the snapshot
    // tool lays them out: the reader asks for the Waves v1 file by the
    // fileHash the chain's import answer gives, and for each archive by
    // the hash its index lists.
    const fixtures = path.join(__dirname, 'fixtures', 'drop-archives');
    const index = JSON.parse(
      fs.readFileSync(path.join(fixtures, 'index-3.json'), 'utf8')
    ) as {
      dropArchiveRoot: string;
      archives: { waveId: string; file: string; hash: string; bytes: number }[];
    };
    // No documents (the empty docsRoot), so no docs index is needed.
    const wavesFile = (root: string, fill = 7) => {
      const bytes = Buffer.alloc(160, fill);
      bytes.writeUInt16BE(0x411d, 0);
      bytes.writeUInt16BE(1, 2);
      Buffer.from(docsRoot([]), 'hex').copy(bytes, 64);
      Buffer.from(root, 'hex').copy(bytes, 96);
      return bytes;
    };
    const waves = wavesFile(index.dropArchiveRoot);
    const wavesHash = keccakHex(waves);
    const chain = { wavesFileHashes: [wavesHash], gatewayVerified: true };
    /** Writes the files and a files.json listing them all. */
    const lay = (entries: Record<string, Buffer>) => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const listed: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(entries)) {
        fs.writeFileSync(path.join(dir, name), bytes);
        listed[name] = createHash('sha256').update(bytes).digest('hex');
      }
      fs.writeFileSync(path.join(dir, FILE_INDEX), JSON.stringify(listed));
    };
    const archives = (list = index.archives) =>
      Object.fromEntries(
        list.map((a) => [
          `keccak256-${a.hash}`,
          fs.readFileSync(path.join(fixtures, a.file))
        ])
      );
    const named = (bytes: Buffer) => ({
      [`keccak256-${keccakHex(bytes)}`]: bytes
    });
    const indexBytes = (value: unknown = index) =>
      Buffer.from(JSON.stringify(value));
    const archiveNames = index.archives.map((a) => `keccak256-${a.hash}`);

    it('reads only keccak256- and 64 lowercase hex digits as such a name', () => {
      expect(namedKeccak256(`keccak256-${'a'.repeat(64)}`)).toBe(
        'a'.repeat(64)
      );
      expect(namedKeccak256(`keccak256-${'A'.repeat(64)}`)).toBe('bad');
      expect(namedKeccak256(`Keccak256-${'a'.repeat(64)}`)).toBe('bad');
      expect(namedKeccak256(`keccak256-${'a'.repeat(64)}.jsonl`)).toBe('bad');
      expect(namedKeccak256('keccak256-abc')).toBe('bad');
      expect(namedKeccak256('waves-v1')).toBeNull();
    });

    it('verifies the Waves v1 file the chain names, a checked index, and each archive it names', async () => {
      lay({
        [`keccak256-${wavesHash}`]: waves,
        [DROP_ARCHIVE_INDEX]: indexBytes(),
        ...archives()
      });
      expect(checkFiles(dir, chain)).toMatchObject({
        problems: [],
        unverified: [],
        waiting: null
      });
      const server = await startFileServer(dir, undefined, chain);
      try {
        expect(server.info.provisional).toBe(false);
        const [first] = index.archives;
        expect(
          await (await fetch(`${server.url}/keccak256-${first.hash}`)).text()
        ).toBe(fs.readFileSync(path.join(fixtures, first.file), 'utf8'));
      } finally {
        await server.stop();
      }
    });

    it('keeps everything provisional, failing nothing, while no import answer names the Waves v1 file', async () => {
      lay({
        [`keccak256-${wavesHash}`]: waves,
        [DROP_ARCHIVE_INDEX]: indexBytes(),
        ...archives()
      });
      const checked = checkFiles(dir);
      expect(checked.problems).toEqual([]);
      expect(checked.unverified).toEqual(
        [`keccak256-${wavesHash}`, DROP_ARCHIVE_INDEX, ...archiveNames].sort()
      );
      const server = await startFileServer(dir);
      try {
        expect(server.info.provisional).toBe(true);
        expect(server.info.provisionalWhy).toMatch(
          /; no Waves v1 file the chain names .* can't be checked against the chain; keccak256-[0-9a-f]{64} is shaped like a Waves v1 file, but no import answer names it$/
        );
        expect(server.problems()).toEqual([]);
      } finally {
        await server.stop();
      }
    });

    it("keeps the named files unverified while the gateway's answer isn't verified", () => {
      lay({
        [`keccak256-${wavesHash}`]: waves,
        [DROP_ARCHIVE_INDEX]: indexBytes(),
        ...archives()
      });
      const checked = checkFiles(dir, { wavesFileHashes: [wavesHash] });
      expect(checked.problems).toEqual([]);
      expect(checked.unverified).toEqual(
        [`keccak256-${wavesHash}`, DROP_ARCHIVE_INDEX, ...archiveNames].sort()
      );
      expect(checked.waiting).toBe(
        "the Waves v1 file, the indexes and the files they list are named by a gateway answer that isn't verified yet"
      );
    });

    it('counts no Waves v1 file when the import answers name more than one', () => {
      const other = 'ab'.repeat(32);
      lay({
        [`keccak256-${wavesHash}`]: waves,
        [DROP_ARCHIVE_INDEX]: indexBytes(),
        ...archives()
      });
      const checked = checkFiles(dir, {
        wavesFileHashes: [other, wavesHash].sort(),
        gatewayVerified: true
      });
      expect(checked.problems).toEqual([]);
      expect(checked.unverified).toEqual(
        [`keccak256-${wavesHash}`, DROP_ARCHIVE_INDEX, ...archiveNames].sort()
      );
      expect(checked.waiting).toContain(
        `the gateway's import answers name more than one Waves v1 file (${[other, wavesHash].sort().join(', ')}), so none counts`
      );
      // The answers name it, so it isn't also called unnamed.
      expect(checked.waiting).not.toContain(
        `keccak256-${wavesHash} is shaped like a Waves v1 file`
      );
    });

    it('lets only the Waves v1 file the chain names vouch for the index', () => {
      // A second Waves-shaped file carries a forged index's root: with the
      // forged index and a forged archive, nothing it vouches for counts.
      const forgedArchive = Buffer.from('{"made":"up","forged":true}\n');
      const forgedIndex = {
        archives: [
          {
            ...index.archives[0],
            hash: keccakHex(forgedArchive),
            bytes: forgedArchive.length
          }
        ]
      };
      const forgedRoot = dropArchiveRoot(forgedIndex.archives);
      const forgedWaves = wavesFile(forgedRoot, 9);
      lay({
        [`keccak256-${wavesHash}`]: waves,
        ...named(forgedWaves),
        [DROP_ARCHIVE_INDEX]: indexBytes(forgedIndex),
        ...named(forgedArchive)
      });
      const checked = checkFiles(dir, chain);
      expect(checked.problems).toEqual([
        `the drop archive index's root ${forgedRoot} is not the dropArchiveRoot of the Waves v1 file the chain names`
      ]);
      expect(checked.waiting).toContain(
        `keccak256-${keccakHex(forgedWaves)} is shaped like a Waves v1 file, but no import answer names it`
      );
      expect(checked.unverified).toEqual(
        [
          DROP_ARCHIVE_INDEX,
          `keccak256-${keccakHex(forgedWaves)}`,
          `keccak256-${keccakHex(forgedArchive)}`
        ].sort()
      );
    });

    it('takes an empty index against the empty root', () => {
      const emptyWaves = wavesFile(dropArchiveRoot([]));
      lay({
        ...named(emptyWaves),
        [DROP_ARCHIVE_INDEX]: indexBytes({ archives: [] })
      });
      expect(
        checkFiles(dir, {
          wavesFileHashes: [keccakHex(emptyWaves)],
          gatewayVerified: true
        })
      ).toMatchObject({ problems: [], unverified: [], waiting: null });
    });

    it('keeps an archive the index does not name provisional', () => {
      const extra = Buffer.from('{"made":"up","n":9}\n');
      lay({
        [`keccak256-${wavesHash}`]: waves,
        [DROP_ARCHIVE_INDEX]: indexBytes(),
        ...archives(),
        ...named(extra)
      });
      expect(checkFiles(dir, chain)).toMatchObject({
        problems: [],
        unverified: [`keccak256-${keccakHex(extra)}`]
      });
    });

    it('stays provisional while an archive the index names is missing, and reports the request for it', async () => {
      const [missing, ...rest] = index.archives;
      lay({
        [`keccak256-${wavesHash}`]: waves,
        [DROP_ARCHIVE_INDEX]: indexBytes(),
        ...archives(rest)
      });
      // The directory isn't the whole set: the archive is lacking, and
      // the source stays provisional, failing nothing.
      expect(checkFiles(dir, chain)).toMatchObject({
        problems: [],
        unverified: [],
        lacking: [`drop-archive-${missing.waveId}`]
      });
      const server = await startFileServer(dir, undefined, chain);
      try {
        expect(server.info.provisional).toBe(true);
        expect(server.info.provisionalWhy).toBe(
          `files the chain names are missing: drop-archive-${missing.waveId}`
        );
        expect(
          (await fetch(`${server.url}/keccak256-${missing.hash}`)).status
        ).toBe(404);
        expect(server.problems().join(' ')).toContain(
          `/keccak256-${missing.hash}`
        );
      } finally {
        await server.stop();
      }
    });

    it('fails on an archive of another size than the index lists, and a named file that is no Waves v1 file', () => {
      const sized = {
        ...index,
        archives: index.archives.map((a, i) =>
          i === 0 ? { ...a, bytes: a.bytes + 1 } : a
        )
      };
      lay({
        [`keccak256-${wavesHash}`]: waves,
        [DROP_ARCHIVE_INDEX]: indexBytes(sized),
        ...archives()
      });
      const [first] = index.archives;
      expect(checkFiles(dir, chain).problems).toEqual([
        `keccak256-${first.hash} is ${first.bytes} bytes, but the drop archive index lists ${first.bytes + 1}`
      ]);
      const notWaves = Buffer.from('not a waves file');
      lay(named(notWaves));
      expect(
        checkFiles(dir, { wavesFileHashes: [keccakHex(notWaves)] }).problems
      ).toEqual([
        `keccak256-${keccakHex(notWaves)} is the file the chain's import answer names, but isn't a Waves v1 file (schema 0x411D, version 1)`
      ]);
    });

    it('refuses other bytes under a Keccak-256 name, and other keccak256- forms', () => {
      lay({
        [`keccak256-${'0'.repeat(64)}`]: Buffer.from('other'),
        'keccak256-ABC': Buffer.from('x'),
        [`Keccak256-${'1'.repeat(64)}`]: Buffer.from('y'),
        [`keccak256-${'2'.repeat(64)}.jsonl`]: Buffer.from('z')
      });
      expect(checkFiles(dir).problems.sort()).toEqual(
        [
          `keccak256-${'0'.repeat(64)} is named by a Keccak-256, but its bytes hash to ${keccakHex(Buffer.from('other'))}`,
          "keccak256-ABC starts keccak256- but isn't keccak256- and 64 lowercase hex digits",
          `Keccak256-${'1'.repeat(64)} starts keccak256- but isn't keccak256- and 64 lowercase hex digits`,
          `keccak256-${'2'.repeat(64)}.jsonl starts keccak256- but isn't keccak256- and 64 lowercase hex digits`
        ].sort()
      );
    });

    it("reads the Waves v1 file hash from the gateway recording's import answer, and waits on that gateway", async () => {
      lay({
        [`keccak256-${wavesHash}`]: waves,
        [DROP_ARCHIVE_INDEX]: indexBytes(),
        ...archives()
      });
      const gatewayDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'rebuild-gateway-')
      );
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-run-'));
      const importPath = '/v1/waves/import?height=9&network=0x01';
      fs.writeFileSync(
        path.join(gatewayDir, 'recording.jsonl'),
        `${JSON.stringify({
          key: exchangeKey('GET', importPath, Buffer.alloc(0)),
          method: 'GET',
          path: importPath,
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { completed: true, fileHash: `0x${wavesHash}` }
          }),
          encoding: 'utf8'
        })}\n`
      );
      const running = await startSources(
        {
          gateway: { kind: 'replay', dir: gatewayDir },
          files: { kind: 'files', dir }
        },
        runDir
      );
      try {
        // A replayed recording isn't verified on this base, so the names
        // it gives wait for it.
        const gateway = running.find((source) => source.name === 'gateway')!;
        expect(gateway.info.provisional).toBe(true);
        const files = running.find((source) => source.name === 'files')!;
        expect(files.info.provisional).toBe(true);
        expect(files.info.provisionalWhy).toMatch(
          /named by a gateway answer that isn't verified yet$/
        );
        expect(files.problems()).toEqual([]);
      } finally {
        await stopSources(running);
        fs.rmSync(gatewayDir, { recursive: true, force: true });
        fs.rmSync(runDir, { recursive: true, force: true });
      }
    });
  });

  describe("the import reader's ids", () => {
    // The waves import's files as the reader lays them out (made-up data):
    // waves-v1, drop-archives, drop-archive-<waveId>, docs-index, and each
    // document under its raw CID.
    const archiveFixtures = path.join(__dirname, 'fixtures', 'drop-archives');
    const docFixtures = path.join(__dirname, 'fixtures', 'wave-docs');
    const archiveIndex = JSON.parse(
      fs.readFileSync(path.join(archiveFixtures, 'index-3.json'), 'utf8')
    ) as {
      dropArchiveRoot: string;
      archives: { waveId: string; file: string; hash: string; bytes: number }[];
    };
    const docsIndexBytes = fs.readFileSync(
      path.join(docFixtures, 'index.json')
    );
    const docsIndex = JSON.parse(docsIndexBytes.toString('utf8')) as {
      docsRoot: string;
      docs: { file: string; rawCid: string; hash: string }[];
    };
    const wavesFile = (docs: string, archives: string, fill = 7) => {
      const bytes = Buffer.alloc(160, fill);
      bytes.writeUInt16BE(0x411d, 0);
      bytes.writeUInt16BE(1, 2);
      Buffer.from(docs, 'hex').copy(bytes, 64);
      Buffer.from(archives, 'hex').copy(bytes, 96);
      return bytes;
    };
    const waves = wavesFile(docsIndex.docsRoot, archiveIndex.dropArchiveRoot);
    const chain = {
      wavesFileHashes: [keccakHex(waves)],
      gatewayVerified: true
    };
    const archiveFiles = (list = archiveIndex.archives) =>
      Object.fromEntries(
        list.map((a) => [
          `drop-archive-${a.waveId}`,
          fs.readFileSync(path.join(archiveFixtures, a.file))
        ])
      );
    const docName = (rawCid: string) =>
      `b${base32Of(Buffer.from(rawCid, 'hex'))}`;
    const docFiles = (list = docsIndex.docs) =>
      Object.fromEntries(
        list.map((d) => [
          docName(d.rawCid),
          fs.readFileSync(path.join(docFixtures, d.file))
        ])
      );
    const set = (): Record<string, Buffer> => ({
      [WAVES_FILE]: waves,
      [DROP_ARCHIVE_INDEX]: fs.readFileSync(
        path.join(archiveFixtures, 'index-3.json')
      ),
      ...archiveFiles(),
      [DOCS_INDEX]: docsIndexBytes,
      ...docFiles()
    });
    const lay = (entries: Record<string, Buffer>) => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const listed: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(entries)) {
        fs.writeFileSync(path.join(dir, name), bytes);
        listed[name] = createHash('sha256').update(bytes).digest('hex');
      }
      fs.writeFileSync(path.join(dir, FILE_INDEX), JSON.stringify(listed));
    };

    it('names each document as its raw CID, which the name check verifies', () => {
      for (const doc of docsIndex.docs) {
        const bytes = fs.readFileSync(path.join(docFixtures, doc.file));
        expect(namedSha256(docName(doc.rawCid))).toBe(
          createHash('sha256').update(bytes).digest('hex')
        );
      }
    });

    it('verifies the whole set the chain names, and the source counts', async () => {
      lay(set());
      expect(checkFiles(dir, chain)).toMatchObject({
        problems: [],
        unverified: [],
        lacking: [],
        waiting: null
      });
      const server = await startFileServer(dir, undefined, chain);
      try {
        expect(server.info.provisional).toBe(false);
        const [archive] = archiveIndex.archives;
        const served = await fetch(
          `${server.url}/drop-archive-${archive.waveId}`
        );
        expect(keccakHex(Buffer.from(await served.arrayBuffer()))).toBe(
          archive.hash
        );
      } finally {
        await server.stop();
      }
    });

    it("fails a waves-v1, an archive or a document with other bytes than the chain's", () => {
      const [archive] = archiveIndex.archives;
      const other = wavesFile(
        docsIndex.docsRoot,
        archiveIndex.dropArchiveRoot,
        9
      );
      lay({ ...set(), [WAVES_FILE]: other });
      expect(checkFiles(dir, chain).problems).toEqual([
        `${WAVES_FILE} hashes to ${keccakHex(other)}, but the chain's import answer names ${chain.wavesFileHashes[0]}`
      ]);
      const forged = Buffer.from('{"forged":true}\n');
      lay({ ...set(), [`drop-archive-${archive.waveId}`]: forged });
      expect(checkFiles(dir, chain).problems).toEqual([
        `drop-archive-${archive.waveId} hashes to ${keccakHex(forged)}, but the drop archive index lists ${archive.hash} for its wave`
      ]);
      // rawCid isn't in the root: an index pointing the commitment
      // document at another document's file keeps its root, and that file
      // fails on the hash.
      const [cidDoc, commitment] = docsIndex.docs;
      const repointed = {
        ...docsIndex,
        docs: docsIndex.docs.map((d) =>
          d === commitment ? { ...d, rawCid: cidDoc.rawCid } : d
        )
      };
      lay({
        ...set(),
        [DOCS_INDEX]: Buffer.from(JSON.stringify(repointed, null, 1))
      });
      const cidBytes = fs.readFileSync(path.join(docFixtures, cidDoc.file));
      expect(checkFiles(dir, chain).problems).toEqual([
        `${docName(cidDoc.rawCid)} hashes to ${keccakHex(cidBytes)}, but the docs index lists ${commitment.hash} for it`
      ]);
    });

    it('stays provisional, failing nothing, while an archive or a document is missing', async () => {
      const [archive] = archiveIndex.archives;
      const [doc] = docsIndex.docs;
      const files = set();
      delete files[`drop-archive-${archive.waveId}`];
      delete files[docName(doc.rawCid)];
      lay(files);
      expect(checkFiles(dir, chain)).toMatchObject({
        problems: [],
        unverified: [],
        lacking: [`drop-archive-${archive.waveId}`, docName(doc.rawCid)]
      });
      const server = await startFileServer(dir, undefined, chain);
      try {
        expect(server.info.provisionalWhy).toBe(
          `files the chain names are missing: drop-archive-${archive.waveId}, ${docName(doc.rawCid)}`
        );
      } finally {
        await server.stop();
      }
    });

    it('stays provisional while an index the Waves v1 file says is not empty is missing', async () => {
      const files = set();
      delete files[DROP_ARCHIVE_INDEX];
      delete files[DOCS_INDEX];
      lay(files);
      const checked = checkFiles(dir, chain);
      expect(checked).toMatchObject({
        problems: [],
        lacking: [DROP_ARCHIVE_INDEX, DOCS_INDEX]
      });
      // The archives wait for the index that would vouch for them.
      expect(checked.unverified).toEqual(
        Object.keys(archiveFiles()).sort((a, b) => (a < b ? -1 : Number(a > b)))
      );
      expect(checked.waiting).toBe(
        'no drop archive index vouches for the archives (drop-archive- or Keccak-named files that are not the Waves v1 file)'
      );
      const server = await startFileServer(dir, undefined, chain);
      try {
        expect(server.info.provisional).toBe(true);
      } finally {
        await server.stop();
      }
      // A Waves v1 file with no archives and no documents needs neither.
      const empty = wavesFile(docsRoot([]), dropArchiveRoot([]));
      lay({ [WAVES_FILE]: empty });
      expect(
        checkFiles(dir, {
          wavesFileHashes: [keccakHex(empty)],
          gatewayVerified: true
        })
      ).toMatchObject({
        problems: [],
        unverified: [],
        lacking: [],
        waiting: null
      });
    });

    it('checks the size an archive under its wave id has, and takes the Waves v1 file under both names', () => {
      const [archive] = archiveIndex.archives;
      const sized = JSON.parse(
        fs.readFileSync(path.join(archiveFixtures, 'index-3.json'), 'utf8')
      );
      sized.archives[0].bytes = archive.bytes + 1;
      lay({
        ...set(),
        [DROP_ARCHIVE_INDEX]: Buffer.from(JSON.stringify(sized)),
        [`keccak256-${keccakHex(waves)}`]: waves
      });
      expect(checkFiles(dir, chain)).toMatchObject({
        problems: [
          `drop-archive-${archive.waveId} is ${archive.bytes} bytes, but the drop archive index lists ${archive.bytes + 1}`
        ],
        unverified: []
      });
    });

    it('fails a docs index that is not JSON', () => {
      lay({ ...set(), [DOCS_INDEX]: Buffer.from('{') });
      expect(checkFiles(dir, chain)).toMatchObject({
        problems: ['the docs index is not JSON'],
        unverified: [DOCS_INDEX]
      });
    });

    it('keeps an archive of a wave the index lists not, and a file of no known kind, provisional', () => {
      const stray = 'ab'.repeat(32);
      lay({
        ...set(),
        [`drop-archive-${stray}`]: Buffer.from('{}\n'),
        extra: Buffer.from('x')
      });
      const checked = checkFiles(dir, chain);
      expect(checked.problems).toEqual([]);
      expect(checked.unverified).toEqual([`drop-archive-${stray}`, 'extra']);
      expect(checked.waiting).toBe(
        `the drop archive index lists no wave for drop-archive-${stray}`
      );
    });

    it("fails a docs index whose root isn't the Waves v1 file's docsRoot", () => {
      const moved = wavesFile('cd'.repeat(32), archiveIndex.dropArchiveRoot);
      lay({ ...set(), [WAVES_FILE]: moved });
      expect(
        checkFiles(dir, {
          wavesFileHashes: [keccakHex(moved)],
          gatewayVerified: true
        }).problems
      ).toEqual([
        `the docs index's root ${docsIndex.docsRoot} is not the docsRoot of the Waves v1 file the chain names`
      ]);
    });

    it('waits on an import answer and on a verified gateway, and fails a named file that is no Waves v1 file', () => {
      lay(set());
      const unanswered = checkFiles(dir, { gatewayVerified: true });
      expect(unanswered.problems).toEqual([]);
      expect(unanswered.unverified).toEqual(
        [
          WAVES_FILE,
          DROP_ARCHIVE_INDEX,
          DOCS_INDEX,
          ...Object.keys(archiveFiles())
        ].sort((a, b) => (a < b ? -1 : Number(a > b)))
      );
      expect(unanswered.waiting).toContain(
        `no import answer names a Waves v1 file, so ${WAVES_FILE} can't be checked against the chain`
      );
      const unverifiedGateway = checkFiles(dir, {
        wavesFileHashes: chain.wavesFileHashes
      });
      expect(unverifiedGateway.unverified).toEqual(unanswered.unverified);
      expect(unverifiedGateway.waiting).toBe(
        "the Waves v1 file, the indexes and the files they list are named by a gateway answer that isn't verified yet"
      );
      const notWaves = Buffer.from('not a Waves v1 file');
      lay({ ...set(), [WAVES_FILE]: notWaves });
      expect(
        checkFiles(dir, {
          wavesFileHashes: [keccakHex(notWaves)],
          gatewayVerified: true
        }).problems
      ).toEqual([
        `${WAVES_FILE} is the file the chain's import answer names, but isn't a Waves v1 file (schema 0x411D, version 1)`
      ]);
    });
  });

  it('counts only the seeds own files, never an outside directory on its label', async () => {
    writeProvenance(dir, { made_by: 'devnet example' });
    const outside = await startFileServer(dir);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-empty-'));
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-seed-'));
    const seedsOnly = await startFileServer(empty, seedDir);
    try {
      expect(outside.info).toMatchObject({
        provenance: 'devnet example',
        provisional: true,
        provisionalWhy: 'ids not verified: artwo, bafyone'
      });
      expect(seedsOnly.info.provisional).toBe(false);
      expect(seedsOnly.info.provisionalWhy).toBeUndefined();
    } finally {
      await outside.stop();
      await seedsOnly.stop();
      fs.rmSync(empty, { recursive: true, force: true });
      fs.rmSync(seedDir, { recursive: true, force: true });
    }
  });
});
