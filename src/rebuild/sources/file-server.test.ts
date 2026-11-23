import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkFiles,
  FILE_INDEX,
  fileIdOf,
  startFileServer
} from '@/rebuild/sources/file-server';
import { writeProvenance } from '@/rebuild/sources/running-source';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

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
        provisionalWhy: 'ids not verified'
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
