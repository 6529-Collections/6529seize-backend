import { createHash } from 'node:crypto';
import { json2csv } from 'json-2-csv';
import { sqlExecutor } from '../sql-executor';
import { handler } from './index';

const send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: (command: unknown) => send(command) })),
  PutObjectCommand: jest.fn((input: unknown) => ({ input }))
}));
jest.mock('../sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('../secrets', () => ({
  doInDbContext: jest.fn(async (work: () => Promise<void>) => work())
}));
jest.mock('../sql-executor', () => ({
  sqlExecutor: { execute: jest.fn() }
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
    send.mock.calls.map(([command]) => [
      command.input.Key,
      { body: command.input.Body, type: command.input.ContentType }
    ])
  );
}

describe('dbDumpsDaily', () => {
  const env = process.env;
  const invoke = () => (handler as unknown as () => Promise<void>)();

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
      complete: true,
      skipped: []
    });
    const sha = (table: string) =>
      createHash('sha256')
        .update(json2csv(rows[table] as object[]))
        .digest('hex');
    expect(manifest.files).toEqual([
      {
        table: 'transactions',
        key: 'db-dumps/production/transactions.csv',
        rows: 1,
        sha256: sha('transactions'),
        source: { kind: 'ethereum', max_block: 23800000 }
      },
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
    expect(manifest.skipped.map((s: { table: string }) => s.table)).toEqual([
      'delegations',
      'consolidations'
    ]);
    expect(manifest.files.map((f: { table: string }) => f.table)).toEqual([
      'transactions',
      'nftdelegation_blocks'
    ]);
  });
});
