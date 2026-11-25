import { createHash } from 'node:crypto';
import { json2csv } from 'json-2-csv';
import { sqlExecutor } from '../sql-executor';
import { handler } from './index';

const send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: (command: unknown) => send(command) })),
  PutObjectCommand: jest.fn((input: unknown) => ({ input, put: true })),
  GetObjectCommand: jest.fn((input: unknown) => ({ input, get: true })),
  HeadObjectCommand: jest.fn((input: unknown) => ({ input, head: true }))
}));
jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('../secrets', () => ({
  doInDbContext: jest.fn(async (work: () => Promise<void>) => work())
}));
jest.mock('../sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn(
      async (work: (connection: unknown) => Promise<unknown>) =>
        work({ connection: {} })
    )
  }
}));

const NOW = Date.UTC(2026, 10, 25, 3, 0, 0);
const rows: Record<string, Record<string, unknown>[]> = {
  transactions: [{ transaction: '0x01', block: 23800000 }],
  delegations: [{ from_address: '0x01', block: 1000004521 }],
  consolidations: [{ wallet1: '0x01', wallet2: '0x02', block: 1000004521 }],
  nftdelegation_blocks: [{ block: 23700000 }]
};

function uploads(): Record<string, { body: string; type: string }> {
  return Object.fromEntries(
    send.mock.calls
      .filter(([command]) => command.put)
      .map(([command]) => [
        command.input.Key,
        { body: command.input.Body, type: command.input.ContentType }
      ])
  );
}

describe('dbDumpsDaily', () => {
  const env = process.env;
  // The daily schedule's event, as EventBridge sends it.
  const invoke = () =>
    (handler as unknown as (e: unknown, c: unknown) => Promise<void>)(
      { source: 'aws.events' },
      {}
    );

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, NODE_ENV: 'production' };
    send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterAll(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  function answer(mirror: Record<string, unknown> | null) {
    jest.mocked(sqlExecutor.execute).mockImplementation(async (sql: string) => {
      if (sql.includes('identity_chain_mirror_state'))
        return mirror ? [mirror] : [];
      if (sql.startsWith('SELECT MAX(block) AS block FROM transactions'))
        return [{ block: 23800000 }];
      if (
        sql.startsWith('SELECT MAX(block) AS block FROM nftdelegation_blocks')
      )
        return [{ block: 23700000 }];
      const table = /FROM (\w+)/.exec(sql)![1];
      return rows[table];
    });
  }

  it('dumps the same files as before, and no manifest, with the flag off', async () => {
    delete process.env.FEATURE_DB_DUMPS_MANIFEST;
    answer(null);

    await invoke();

    expect(Object.keys(uploads()).sort()).toEqual(
      [
        'db-dumps/production/consolidations.csv',
        'db-dumps/production/delegations.csv',
        'db-dumps/production/nftdelegation_blocks.csv',
        'db-dumps/production/transactions.csv'
      ].sort()
    );
  });

  it('writes a manifest naming each file, its hash and its source', async () => {
    process.env.FEATURE_DB_DUMPS_MANIFEST = 'true';
    answer({ next_height: 4521, sync_phase: null, updated_at: NOW - 60_000 });

    await invoke();

    const files = uploads();
    const manifest = JSON.parse(
      files['db-dumps/production/manifest.json'].body
    );
    expect(files['db-dumps/production/manifest.json'].type).toBe(
      'application/json'
    );
    expect(manifest).toMatchObject({
      version: 1,
      generated_at: '2026-11-25T03:00:00.000Z',
      complete: true
    });
    const sha = (table: string) =>
      createHash('sha256')
        .update(json2csv(rows[table] as object[]))
        .digest('hex');
    // The chain files first, from one snapshot; the manifest last.
    expect(manifest.files).toEqual([
      {
        table: 'delegations',
        key: 'db-dumps/production/delegations.csv',
        rows: 1,
        sha256: sha('delegations'),
        source: {
          kind: 'identity_chain_mirror',
          next_height: 4521,
          updated_at: NOW - 60_000
        }
      },
      expect.objectContaining({
        table: 'consolidations',
        sha256: sha('consolidations'),
        source: expect.objectContaining({ kind: 'identity_chain_mirror' })
      }),
      {
        table: 'transactions',
        key: 'db-dumps/production/transactions.csv',
        rows: 1,
        sha256: sha('transactions'),
        source: { kind: 'ethereum', max_block: 23800000 }
      },
      {
        table: 'nftdelegation_blocks',
        key: 'db-dumps/production/nftdelegation_blocks.csv',
        rows: 1,
        sha256: sha('nftdelegation_blocks'),
        source: { kind: 'nftdelegation', last_block: 23700000 }
      }
    ]);
    expect(files['db-dumps/production/transactions.csv'].body).toBe(
      json2csv(rows.transactions as object[])
    );
    const keys = send.mock.calls.map(([command]) => command.input.Key);
    expect(keys[keys.length - 1]).toBe('db-dumps/production/manifest.json');
  });

  it('keeps the previous chain files while the mirror is mid-pass, and says so', async () => {
    process.env.FEATURE_DB_DUMPS_MANIFEST = 'true';
    answer({ next_height: 4521, sync_phase: 'DELEGATIONS', updated_at: NOW });

    await invoke();

    const files = uploads();
    expect(files['db-dumps/production/delegations.csv']).toBeUndefined();
    expect(files['db-dumps/production/consolidations.csv']).toBeUndefined();
    const manifest = JSON.parse(
      files['db-dumps/production/manifest.json'].body
    );
    expect(manifest.complete).toBe(false);
    // A skipped file keeps an entry that says so; its previous CSV stays.
    expect(manifest.files.slice(0, 2)).toEqual([
      {
        table: 'delegations',
        key: 'db-dumps/production/delegations.csv',
        skipped: expect.stringContaining('has not finished a full pass')
      },
      {
        table: 'consolidations',
        key: 'db-dumps/production/consolidations.csv',
        skipped: expect.stringContaining('has not finished a full pass')
      }
    ]);
    expect(manifest.files.map((f: { table: string }) => f.table)).toEqual([
      'delegations',
      'consolidations',
      'transactions',
      'nftdelegation_blocks'
    ]);
  });

  // When the previous manifest went up, and when each CSV was last written.
  const MANIFEST_WRITTEN = new Date('2026-11-24T03:01:05Z');
  const CSV_WRITTEN = new Date('2026-11-24T03:01:04Z');

  /** The manifest a GetObject finds (or a missing object), and the CSVs' times. */
  function previousManifest(
    manifest: object | null,
    csvWritten: Date = CSV_WRITTEN
  ) {
    send.mockImplementation(async (command) => {
      if (command.head)
        return { $metadata: { httpStatusCode: 200 }, LastModified: csvWritten };
      if (!command.get) return { $metadata: { httpStatusCode: 200 } };
      if (!manifest)
        throw Object.assign(new Error('The specified key does not exist.'), {
          name: 'NoSuchKey'
        });
      return {
        $metadata: { httpStatusCode: 200 },
        LastModified: MANIFEST_WRITTEN,
        Body: { transformToString: async () => JSON.stringify(manifest) }
      };
    });
  }

  const delegationsEntry = {
    table: 'delegations',
    key: 'db-dumps/production/delegations.csv',
    rows: 12,
    sha256: 'a'.repeat(64),
    source: {
      kind: 'identity_chain_mirror',
      next_height: 4400,
      updated_at: NOW - 86_400_000
    }
  };

  it("carries a skipped file's hash, rows and source forward, with the time it was written", async () => {
    process.env.FEATURE_DB_DUMPS_MANIFEST = 'true';
    answer({ next_height: 4521, sync_phase: 'DELEGATIONS', updated_at: NOW });
    previousManifest({
      version: 1,
      generated_at: '2026-11-24T03:00:00.000Z',
      complete: true,
      files: [delegationsEntry]
    });

    await invoke();

    const manifest = JSON.parse(
      uploads()['db-dumps/production/manifest.json'].body
    );
    expect(manifest.complete).toBe(false);
    expect(manifest.files.slice(0, 2)).toEqual([
      {
        ...delegationsEntry,
        generated_at: '2026-11-24T03:00:00.000Z',
        skipped: expect.stringContaining('has not finished a full pass')
      },
      // No earlier description of this file: the entry says only why.
      {
        table: 'consolidations',
        key: 'db-dumps/production/consolidations.csv',
        skipped: expect.stringContaining('has not finished a full pass')
      }
    ]);
    // The previous manifest is read before anything goes up.
    expect(send.mock.calls[0][0]).toMatchObject({
      get: true,
      input: { Key: 'db-dumps/production/manifest.json' }
    });
  });

  it('keeps the first time through a run of skips', async () => {
    process.env.FEATURE_DB_DUMPS_MANIFEST = 'true';
    answer({ next_height: 4521, sync_phase: 'DELEGATIONS', updated_at: NOW });
    previousManifest({
      version: 1,
      generated_at: '2026-11-24T03:00:00.000Z',
      complete: false,
      files: [
        {
          ...delegationsEntry,
          generated_at: '2026-11-20T03:00:00.000Z',
          skipped: 'the identity mirror is mid-pass'
        }
      ]
    });

    await invoke();

    const manifest = JSON.parse(
      uploads()['db-dumps/production/manifest.json'].body
    );
    expect(manifest.files[0]).toEqual({
      ...delegationsEntry,
      generated_at: '2026-11-20T03:00:00.000Z',
      skipped: expect.stringContaining('has not finished a full pass')
    });
  });

  it('carries nothing over a CSV written after the previous manifest', async () => {
    process.env.FEATURE_DB_DUMPS_MANIFEST = 'true';
    answer({ next_height: 4521, sync_phase: 'DELEGATIONS', updated_at: NOW });
    // A run with the flag off rewrote the CSV the next day.
    previousManifest(
      {
        version: 1,
        generated_at: '2026-11-24T03:00:00.000Z',
        complete: true,
        files: [delegationsEntry]
      },
      new Date('2026-11-25T01:00:10Z')
    );

    await invoke();

    const manifest = JSON.parse(
      uploads()['db-dumps/production/manifest.json'].body
    );
    expect(manifest.files[0]).toEqual({
      table: 'delegations',
      key: 'db-dumps/production/delegations.csv',
      skipped: expect.stringContaining('has not finished a full pass')
    });
  });

  it('still writes the dumps when there is no previous manifest to read', async () => {
    process.env.FEATURE_DB_DUMPS_MANIFEST = 'true';
    answer({ next_height: 4521, sync_phase: 'DELEGATIONS', updated_at: NOW });
    previousManifest(null);

    await invoke();

    const manifest = JSON.parse(
      uploads()['db-dumps/production/manifest.json'].body
    );
    expect(manifest.files[0]).toEqual({
      table: 'delegations',
      key: 'db-dumps/production/delegations.csv',
      skipped: expect.stringContaining('has not finished a full pass')
    });
    expect(uploads()['db-dumps/production/transactions.csv']).toBeDefined();
  });
});
