import { DataSource, Table, TableColumn } from 'typeorm';
import { applyClaimsMediaUploadSchema } from './claims-media-schema';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));

const token =
  'ALTER TABLE `minting_claims` ADD `media_upload_lease_token` varchar(36) NULL';
const until =
  'ALTER TABLE `minting_claims` ADD `media_upload_lease_until` bigint NULL';
const column = (name: string, overrides: Record<string, unknown> = {}) =>
  new TableColumn({
    name,
    type: name === 'media_upload_lease_token' ? 'varchar' : 'bigint',
    length: name === 'media_upload_lease_token' ? '36' : '',
    isNullable: true,
    ...overrides
  });

function fixture(columns: TableColumn[], statements: string[], exists = true) {
  const runner = {
    getTable: jest
      .fn()
      .mockResolvedValue(
        exists ? new Table({ name: 'minting_claims', columns }) : undefined
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

describe('claims media live schema plan guard', () => {
  it('executes only the inspected two additions on the primary', async () => {
    const f = fixture([], [token, until]);
    await expect(applyClaimsMediaUploadSchema(f.source)).resolves.toBe(2);
    expect(f.source.createQueryRunner).toHaveBeenCalledWith('master');
    expect(f.runner.query.mock.calls).toEqual([[token], [until]]);
    expect(f.log).toHaveBeenCalledTimes(2);
    expect(f.source.synchronize).not.toHaveBeenCalled();
    expect(f.runner.release).toHaveBeenCalledTimes(1);
  });

  it('accepts an aligned table without any DDL', async () => {
    const f = fixture(
      [column('media_upload_lease_token'), column('media_upload_lease_until')],
      []
    );
    await expect(applyClaimsMediaUploadSchema(f.source)).resolves.toBe(0);
    expect(f.runner.query).not.toHaveBeenCalled();
  });

  it('resumes a partial addition without changing the existing column', async () => {
    const f = fixture([column('media_upload_lease_token')], [until]);
    await expect(applyClaimsMediaUploadSchema(f.source)).resolves.toBe(1);
    expect(f.runner.query.mock.calls).toEqual([[until]]);
  });

  it.each([
    'ALTER TABLE `minting_claims` DROP COLUMN `description`',
    'ALTER TABLE `minting_claims` MODIFY `name` varchar(10)',
    'ALTER TABLE `minting_claims` ADD `unexpected` int NULL',
    'ALTER TABLE `another_table` ADD `media_upload_lease_until` bigint NULL',
    'CREATE TABLE `minting_claims` (`media_upload_lease_until` bigint NULL)',
    token + '; DROP TABLE minting_claims'
  ])(
    'rejects the complete plan before any DDL when it contains %s',
    async (unexpected) => {
      const f = fixture([], [token, until, unexpected]);
      await expect(applyClaimsMediaUploadSchema(f.source)).rejects.toThrow(
        'unapproved changes'
      );
      expect(f.runner.query).not.toHaveBeenCalled();
      expect(f.runner.release).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    { length: '35' },
    { isNullable: false },
    { type: 'text' },
    { default: "'forced'" }
  ])('rejects an incompatible existing token column %j', async (overrides) => {
    const f = fixture([column('media_upload_lease_token', overrides)], [until]);
    await expect(applyClaimsMediaUploadSchema(f.source)).rejects.toThrow(
      'incompatible'
    );
    expect(f.log).not.toHaveBeenCalled();
    expect(f.runner.query).not.toHaveBeenCalled();
  });

  it('rejects a missing table before generating or executing a plan', async () => {
    const f = fixture([], [], false);
    await expect(applyClaimsMediaUploadSchema(f.source)).rejects.toThrow(
      'existing claims table'
    );
    expect(f.log).not.toHaveBeenCalled();
    expect(f.runner.query).not.toHaveBeenCalled();
  });

  it.each([[token], [token, token, until]])(
    'rejects incomplete or duplicate additions %j',
    async (...statements) => {
      const f = fixture([], statements);
      await expect(applyClaimsMediaUploadSchema(f.source)).rejects.toThrow(
        'Claim media schema plan'
      );
      expect(f.runner.query).not.toHaveBeenCalled();
    }
  );

  it('stops on a concurrent DDL failure without recomputing or dropping anything', async () => {
    const f = fixture([], [token, until]);
    const failure = new Error('synthetic concurrent schema change');
    f.runner.query.mockRejectedValueOnce(failure);
    await expect(applyClaimsMediaUploadSchema(f.source)).rejects.toBe(failure);
    expect(f.runner.query.mock.calls).toEqual([[token]]);
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(f.source.synchronize).not.toHaveBeenCalled();
  });

  it('does not undo the first addition when the second fails; a fresh attempt adds only the remainder', async () => {
    const f = fixture([], [token, until]);
    f.runner.query
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('synthetic second ADD failure'));
    await expect(applyClaimsMediaUploadSchema(f.source)).rejects.toThrow(
      'second ADD failure'
    );
    expect(f.runner.query.mock.calls).toEqual([[token], [until]]);
    const retry = fixture([column('media_upload_lease_token')], [until]);
    await expect(applyClaimsMediaUploadSchema(retry.source)).resolves.toBe(1);
    expect(retry.runner.query.mock.calls).toEqual([[until]]);
  });

  it('fails acknowledgment if a fresh read finds drift after the approved additions', async () => {
    const f = fixture([], [token, until]);
    f.log.mockResolvedValueOnce({ upQueries: [{ query: 'unexpected drift' }] });
    await expect(applyClaimsMediaUploadSchema(f.source)).rejects.toThrow(
      'expected state'
    );
    expect(f.runner.query.mock.calls).toEqual([[token], [until]]);
    expect(f.source.synchronize).not.toHaveBeenCalled();
  });
});
