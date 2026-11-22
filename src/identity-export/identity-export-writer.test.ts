import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IdentityExportUsageError } from './cli-options';
import {
  checkOutPath,
  writeExportFile,
  writeJsonDocument
} from './identity-export.writer';

describe('writeJsonDocument', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-export-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes what JSON.stringify would, one element a line', async () => {
    const document = {
      format: '6529.identity-export.v1',
      freeze_ms: null,
      identities: [
        {
          profile_id: 'a',
          wallets: ['0x1', '0x2'],
          website: 'https://e.org/"q"'
        },
        { profile_id: null, wallets: [] }
      ],
      ratings: [],
      stats: { identities: 2 },
      skipped: undefined
    };
    const file = path.join(dir, 'export.json');
    await writeJsonDocument(file, document);
    const text = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(document)));
    expect(
      text.split('\n').filter((it) => it.startsWith('    {'))
    ).toHaveLength(2);
  });

  it('writes the file through a temporary one, without the sync state', async () => {
    const file = path.join(dir, 'export.json');
    await writeExportFile(
      file,
      {
        format: '6529.identity-export.v1',
        identity_sync: { pendingGeneration: 1 },
        stats: { identity_sync_pending_generation: 1 }
      },
      false
    );
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written).toEqual({
      format: '6529.identity-export.v1',
      stats: { identity_sync_pending_generation: 1 }
    });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('refuses an existing file unless told to replace it', async () => {
    const file = path.join(dir, 'export.json');
    fs.writeFileSync(file, 'old');
    expect(() => checkOutPath(file, false)).toThrow(IdentityExportUsageError);
    await expect(writeExportFile(file, { a: 1 }, false)).rejects.toThrow(
      'pass --overwrite to replace it'
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    await writeExportFile(file, { a: 1 }, true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(() => checkOutPath(path.join(dir, 'new.json'), false)).not.toThrow();
  });

  it('refuses a missing directory, and a write there fails instead of hanging', async () => {
    const missing = path.join(dir, 'nowhere', 'export.json');
    expect(() => checkOutPath(missing, false)).toThrow(
      'is not a directory that can be written'
    );
    // Large enough to wait for the stream to drain when the error comes.
    const big = {
      identities: Array.from({ length: 5_000 }, (_, i) => ({
        profile_id: `p-${i}`,
        wallets: ['0x1', '0x2']
      }))
    };
    await expect(writeJsonDocument(missing, big)).rejects.toThrow();
    await expect(writeJsonDocument(missing, { a: [1, 2] })).rejects.toThrow();
    const notDir = path.join(dir, 'file');
    fs.writeFileSync(notDir, 'x');
    expect(() => checkOutPath(path.join(notDir, 'export.json'), true)).toThrow(
      'is not a directory that can be written'
    );
  }, 10_000);
});
