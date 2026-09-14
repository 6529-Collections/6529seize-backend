import { DataSource, Table, TableColumn } from 'typeorm';
import { applyNftLinkPageRetrySchema } from './nft-link-page-retry-schema';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
const add = 'ALTER TABLE `nft_links` ADD `refresh_retry_state` json NULL';
const column = (overrides = {}) =>
  new TableColumn({
    name: 'refresh_retry_state',
    type: 'json',
    isNullable: true,
    ...overrides
  });
function fixture(columns: TableColumn[], statements: string[], exists = true) {
  const runner = {
    getTable: jest
      .fn()
      .mockResolvedValue(
        exists ? new Table({ name: 'nft_links', columns }) : undefined
      ),
    query: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined)
  };
  const log = jest
    .fn()
    .mockResolvedValue({ upQueries: [] })
    .mockResolvedValueOnce({
      upQueries: statements.map((query) => ({ query }))
    });
  const source = {
    createQueryRunner: jest.fn(() => runner),
    driver: { createSchemaBuilder: jest.fn(() => ({ log })) },
    synchronize: jest.fn()
  };
  return { source: source as unknown as DataSource, runner, log };
}

describe('NFT retry explicit additive schema guard', () => {
  it('runs exactly the inspected single-column DDL on the primary, without synchronization', async () => {
    const f = fixture([], [add]);
    await expect(applyNftLinkPageRetrySchema(f.source)).resolves.toBe(1);
    expect(f.source.createQueryRunner).toHaveBeenCalledWith('master');
    expect(f.runner.query.mock.calls).toEqual([[add]]);
    expect(f.log).toHaveBeenCalledTimes(2);
    expect(f.source.synchronize).not.toHaveBeenCalled();
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });
  it('is idempotent after success or an ambiguous acknowledged DDL', async () => {
    const f = fixture([column()], []);
    await expect(applyNftLinkPageRetrySchema(f.source)).resolves.toBe(0);
    expect(f.runner.query).not.toHaveBeenCalled();
  });
  it.each(
    [
      [],
      [add, add],
      [add, 'DROP TABLE nft_links'],
      ['ALTER TABLE `nft_links` ADD `other` json NULL'],
      ['ALTER TABLE `other` ADD `refresh_retry_state` json NULL'],
      [add + '; DROP TABLE nft_links']
    ].map((statements) => ({ statements }))
  )(
    'rejects missing/duplicate/unrelated/destructive plan %j before DDL',
    async ({ statements }) => {
      const f = fixture([], statements);
      await expect(applyNftLinkPageRetrySchema(f.source)).rejects.toThrow(
        'unapproved or missing'
      );
      expect(f.runner.query).not.toHaveBeenCalled();
    }
  );
  it.each([
    { type: 'text' },
    { isNullable: false },
    { default: "'{}'" },
    { isPrimary: true },
    { isGenerated: true }
  ])('rejects incompatible existing state %j', async (overrides) => {
    const f = fixture([column(overrides)], []);
    await expect(applyNftLinkPageRetrySchema(f.source)).rejects.toThrow(
      'incompatible'
    );
    expect(f.log).not.toHaveBeenCalled();
  });
  it('rejects table absence and parameterized DDL without writes', async () => {
    const absent = fixture([], [], false);
    await expect(applyNftLinkPageRetrySchema(absent.source)).rejects.toThrow(
      'existing nft_links'
    );
    const params = fixture([], []);
    params.log.mockReset().mockResolvedValue({
      upQueries: [{ query: add, parameters: ['extra'] }]
    });
    await expect(applyNftLinkPageRetrySchema(params.source)).rejects.toThrow(
      'unapproved'
    );
    expect(params.runner.query).not.toHaveBeenCalled();
  });
  it('does not retry DDL blindly or acknowledge drift after an addition', async () => {
    const failed = fixture([], [add]);
    failed.runner.query.mockRejectedValueOnce(
      new Error('synthetic DDL failure')
    );
    await expect(applyNftLinkPageRetrySchema(failed.source)).rejects.toThrow(
      'DDL failure'
    );
    expect(failed.log).toHaveBeenCalledTimes(1);
    const drift = fixture([], [add]);
    drift.log.mockResolvedValueOnce({
      upQueries: [{ query: 'unexpected drift' }]
    });
    await expect(applyNftLinkPageRetrySchema(drift.source)).rejects.toThrow(
      'expected state'
    );
    expect(drift.runner.query).toHaveBeenCalledTimes(1);
  });
});
