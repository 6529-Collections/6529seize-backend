import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';
import { ProfileCmsPackagesDb } from './profile-cms-packages.db';

it('serves committed package ids and private lists from the writer while public primary reads may use replicas', async () => {
  const committed = {
    id: 'saved',
    status: 'DRAFT',
    cms_package: {},
    storage_receipts: [],
    is_primary: false,
    production_valid: false,
    recovery_receipt: { uri: 'ar://manifest' }
  };
  const oneOrNull = jest.fn(
    async (
      _sql: string,
      _params?: Record<string, unknown>,
      options?: DbQueryOptions
    ) => (options?.forcePool === DbPoolName.WRITE ? committed : null)
  );
  const execute = jest.fn(
    async (
      _sql: string,
      _params?: Record<string, unknown>,
      options?: DbQueryOptions
    ) => (options?.forcePool === DbPoolName.WRITE ? [committed] : [])
  );
  const database = new ProfileCmsPackagesDb(
    () => ({ oneOrNull, execute }) as unknown as SqlExecutor
  );
  await expect(database.findById('saved', {})).resolves.toMatchObject({
    id: 'saved',
    recovery_receipt: { uri: 'ar://manifest' }
  });
  await expect(
    database.listByProfile('profile', true, {})
  ).resolves.toHaveLength(1);
  await expect(database.listByProfile('profile', false, {})).resolves.toEqual(
    []
  );
  await expect(
    database.findPrimaryPublishedByProfileId('profile', {})
  ).resolves.toBeNull();
  await expect(
    database.findPrimaryPublishedByProfileId('profile', {}, DbPoolName.WRITE)
  ).resolves.toMatchObject({ id: 'saved' });
});
