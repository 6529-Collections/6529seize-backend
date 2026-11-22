import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IdentityExportNotReadyError } from './identity-export.errors';

const buildIdentityExport = jest.fn();

jest.mock('@/secrets', () => ({
  doInDbContext: (fn: () => Promise<unknown>) => fn()
}));
const dbApiCalls: string[] = [];
jest.mock('@/db-api', () => ({
  connect: async () => {
    dbApiCalls.push('connect');
  },
  disconnect: async () => {
    dbApiCalls.push('disconnect');
  },
  withReadOnlySnapshot: (work: (connection: unknown) => Promise<unknown>) => {
    dbApiCalls.push('snapshot');
    return work({});
  }
}));
jest.mock('@/sql-executor', () => ({ sqlExecutor: { execute: jest.fn() } }));
jest.mock('./identity-export.db', () => ({
  SqlIdentityExportSource: class {}
}));
jest.mock('./identity-export.service', () => ({
  buildIdentityExport: (...args: unknown[]) => buildIdentityExport(...args)
}));

import { runCli } from './cli';

const REV = 'f'.repeat(40);

describe('runCli', () => {
  let dir: string;
  let stderr: jest.SpyInstance;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-export-cli-'));
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    buildIdentityExport.mockReset();
    dbApiCalls.length = 0;
  });
  afterEach(() => {
    stderr.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const args = (out: string) => [
    '--out',
    out,
    '--revision',
    REV,
    '--no-freeze',
    '--no-extra-ids'
  ];

  it('exits 3, writing nothing, when the database is not at the freeze day', async () => {
    buildIdentityExport.mockRejectedValue(
      new IdentityExportNotReadyError('the identities sync is behind')
    );
    const out = path.join(dir, 'export.json');
    expect(await runCli(args(out))).toBe(3);
    const written = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(written).toContain(
      'the identities sync is behind: nothing was written'
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  it.each([
    ['over_credit', 4],
    ['after_freeze', 5],
    ['day', 3]
  ] as const)('exits by its cause: %s', async (cause, code) => {
    buildIdentityExport.mockRejectedValue(
      new IdentityExportNotReadyError([{ cause, message: 'not yet' }])
    );
    expect(await runCli(args(path.join(dir, 'export.json')))).toBe(code);
  });

  it('exits 2 on a usage error, and on an existing file before reading', async () => {
    expect(await runCli(['--out', 'x'])).toBe(2);
    const out = path.join(dir, 'export.json');
    fs.writeFileSync(out, 'old');
    expect(await runCli(args(out))).toBe(2);
    expect(buildIdentityExport).not.toHaveBeenCalled();
    expect(fs.readFileSync(out, 'utf8')).toBe('old');
  });

  it('writes the file without the sync state and exits 0', async () => {
    buildIdentityExport.mockResolvedValue({
      format: '6529.identity-export.v1',
      tdh_block: 1,
      freeze_ms: null,
      stats: { identities: 0 },
      notes: [],
      identity_sync: { pendingGeneration: 1 }
    });
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const out = path.join(dir, 'export.json');
      expect(await runCli(args(out))).toBe(0);
      const written = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(written.identity_sync).toBeUndefined();
      expect(written.stats).toEqual({ identities: 0 });
      // db-api's pools are opened for the snapshot and closed after it.
      expect(dbApiCalls).toEqual(['connect', 'snapshot', 'disconnect']);
    } finally {
      stdout.mockRestore();
    }
  });
});
