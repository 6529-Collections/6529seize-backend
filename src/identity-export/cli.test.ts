import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IdentityExportNotReadyError } from './identity-export.errors';

const buildIdentityExport = jest.fn();

const prepEnvironment = jest.fn(async (): Promise<void> => undefined);
jest.mock('@/env', () => ({
  ...jest.requireActual('@/env'),
  prepEnvironment: () => prepEnvironment()
}));
let disconnectFails = false;
const dbApiCalls: string[] = [];
jest.mock('@/db-api', () => ({
  connect: async () => {
    dbApiCalls.push('connect');
  },
  disconnect: async () => {
    dbApiCalls.push('disconnect');
    if (disconnectFails) throw new Error('pool already closed');
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
const T = Date.UTC(2026, 10, 24);
const ALICE = '00000000-0000-4000-8000-0000000a11ce';

const sha256 = (text: string) =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

describe('runCli', () => {
  let dir: string;
  let stderr: jest.SpyInstance;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-export-cli-'));
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    buildIdentityExport.mockReset();
    dbApiCalls.length = 0;
    disconnectFails = false;
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
    '--no-extra-ids',
    '--no-cms-fields'
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
    ['day', 3],
    ['missing_extra_ids', 6],
    ['unmatched_cms', 7]
  ] as const)(
    'exits by its cause, writing nothing: %s',
    async (cause, code) => {
      buildIdentityExport.mockRejectedValue(
        new IdentityExportNotReadyError([{ cause, message: 'not yet' }])
      );
      const out = path.join(dir, 'export.json');
      expect(await runCli(args(out))).toBe(code);
      expect(fs.existsSync(out)).toBe(false);
    }
  );

  describe('at the freeze', () => {
    const saved = process.env.IDENTITY_FREEZE_AT;
    afterEach(() => {
      if (saved === undefined) delete process.env.IDENTITY_FREEZE_AT;
      else process.env.IDENTITY_FREEZE_AT = saved;
      prepEnvironment.mockReset();
      prepEnvironment.mockImplementation(async () => undefined);
    });

    /** The inputs of an export at the freeze; the manifest as given. */
    const atFreeze = (
      manifest: (cmsSha: string) => object,
      cms = JSON.stringify({ [ALICE]: { primary: {} } })
    ) => {
      fs.writeFileSync(path.join(dir, 'cms-fields.json'), cms);
      fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify([ALICE]));
      const manifestText = JSON.stringify(manifest(sha256(cms)));
      fs.writeFileSync(path.join(dir, 'manifest.json'), manifestText);
      return {
        manifestSha: sha256(manifestText),
        cmsSha: sha256(cms),
        args: [
          '--out',
          path.join(dir, 'export.json'),
          '--revision',
          REV,
          '--freeze-at',
          String(T),
          '--expect-tdh-block',
          '1',
          '--extra-ids',
          path.join(dir, 'waves.json'),
          '--cms-fields',
          path.join(dir, 'cms-fields.json'),
          '--cms-manifest',
          path.join(dir, 'manifest.json')
        ]
      };
    };
    const siteManifest = (cmsSha: string) => ({
      schema: '6529.profile-site-export.manifest.v1',
      usable: true,
      rehearsal: false,
      stage: 'prod',
      frozen_at: '2026-11-24T00:00:00.000Z',
      files: [{ name: 'cms-fields.json', bytes: 1, sha256: cmsSha }]
    });

    it("takes IDENTITY_FREEZE_AT from the environment's files, and refuses without it", async () => {
      delete process.env.IDENTITY_FREEZE_AT;
      const { args: given } = atFreeze(siteManifest);
      expect(await runCli(given)).toBe(2);
      const written = stderr.mock.calls.map(([text]) => String(text)).join('');
      expect(written).toContain('IDENTITY_FREEZE_AT is not set');
      expect(dbApiCalls).toEqual([]);
      expect(buildIdentityExport).not.toHaveBeenCalled();

      // The .env file sets it to another day.
      prepEnvironment.mockImplementation(async () => {
        process.env.IDENTITY_FREEZE_AT = '2026-11-25T00:00:00Z';
      });
      expect(await runCli(given)).toBe(2);
      expect(dbApiCalls).toEqual([]);

      // ...or to the freeze.
      delete process.env.IDENTITY_FREEZE_AT;
      prepEnvironment.mockImplementation(async () => {
        process.env.IDENTITY_FREEZE_AT = String(T);
      });
      buildIdentityExport.mockRejectedValue(
        new IdentityExportNotReadyError([{ cause: 'day', message: 'not yet' }])
      );
      expect(await runCli(given)).toBe(3);
      expect(buildIdentityExport).toHaveBeenCalled();
    });

    it("records the profile site run's manifest that lists the values", async () => {
      process.env.IDENTITY_FREEZE_AT = '2026-11-24T00:00:00Z';
      const { args: given, manifestSha, cmsSha } = atFreeze(siteManifest);
      buildIdentityExport.mockRejectedValue(
        new IdentityExportNotReadyError([{ cause: 'day', message: 'not yet' }])
      );
      expect(await runCli(given)).toBe(3);
      expect(buildIdentityExport.mock.calls[0][1].cmsFieldsFile).toEqual({
        count: 1,
        sha256: cmsSha,
        manifest: { key: null, sha256: manifestSha }
      });
    });

    it('takes an empty cms-fields.json its manifest lists: a site export with no sites', async () => {
      process.env.IDENTITY_FREEZE_AT = '2026-11-24T00:00:00Z';
      const { args: given, cmsSha } = atFreeze(siteManifest, '{}');
      buildIdentityExport.mockRejectedValue(
        new IdentityExportNotReadyError([{ cause: 'day', message: 'not yet' }])
      );
      expect(await runCli(given)).toBe(3);
      const options = buildIdentityExport.mock.calls[0][1];
      expect(options.cmsFields).toEqual({});
      expect(options.cmsFieldsFile).toEqual(
        expect.objectContaining({ count: 0, sha256: cmsSha })
      );
    });

    it.each([
      [
        'a rehearsal',
        (sha: string) => ({
          ...siteManifest(sha),
          usable: false,
          rehearsal: true
        }),
        'not of a whole, usable run'
      ],
      [
        'another freeze',
        (sha: string) => ({
          ...siteManifest(sha),
          frozen_at: '2026-11-23T00:00:00.000Z'
        }),
        'exported the freeze "2026-11-23T00:00:00.000Z", not 2026-11-24T00:00:00.000Z'
      ],
      [
        'another file',
        (_sha: string) => siteManifest('0'.repeat(64)),
        'lists cms-fields.json with sha256 0000'
      ],
      [
        'another schema',
        (sha: string) => ({ ...siteManifest(sha), schema: 'x' }),
        'schema is "x"'
      ]
    ])(
      'refuses the manifest of %s before reading',
      async (_name, manifest, message) => {
        process.env.IDENTITY_FREEZE_AT = '2026-11-24T00:00:00Z';
        const { args: given } = atFreeze(manifest);
        expect(await runCli(given)).toBe(2);
        const written = stderr.mock.calls
          .map(([text]) => String(text))
          .join('');
        expect(written).toContain(message);
        expect(dbApiCalls).toEqual([]);
      }
    );
  });

  it('says so when --no-freeze leaves IDENTITY_FREEZE_AT aside', async () => {
    const saved = process.env.IDENTITY_FREEZE_AT;
    process.env.IDENTITY_FREEZE_AT = '2026-11-24T00:00:00Z';
    try {
      buildIdentityExport.mockRejectedValue(
        new IdentityExportNotReadyError([{ cause: 'day', message: 'no' }])
      );
      expect(await runCli(args(path.join(dir, 'r.json')))).toBe(3);
      const written = stderr.mock.calls.map(([text]) => String(text)).join('');
      expect(written).toContain(
        'IDENTITY_FREEZE_AT is set ("2026-11-24T00:00:00Z"), but --no-freeze writes a rehearsal'
      );
      expect(buildIdentityExport.mock.calls[0][1].freezeMs).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.IDENTITY_FREEZE_AT;
      else process.env.IDENTITY_FREEZE_AT = saved;
    }
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
      // The environment, then db-api's pools for the snapshot, closed after.
      expect(prepEnvironment).toHaveBeenCalled();
      expect(dbApiCalls).toEqual(['connect', 'snapshot', 'disconnect']);
    } finally {
      stdout.mockRestore();
    }
  });

  it('keeps the exit code when closing the pools fails', async () => {
    disconnectFails = true;
    buildIdentityExport.mockRejectedValue(
      new IdentityExportNotReadyError([{ cause: 'over_credit', message: 'no' }])
    );
    expect(await runCli(args(path.join(dir, 'a.json')))).toBe(4);
    buildIdentityExport.mockResolvedValue({
      format: '6529.identity-export.v1',
      tdh_block: 1,
      freeze_ms: null,
      stats: {},
      notes: []
    });
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      expect(await runCli(args(path.join(dir, 'b.json')))).toBe(0);
    } finally {
      stdout.mockRestore();
    }
    const written = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(written).toContain('closing the database pools failed');
  });
});
