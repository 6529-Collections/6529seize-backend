import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkFiles,
  FILE_INDEX,
  fileIdOf,
  namedSha256,
  startFileServer
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
