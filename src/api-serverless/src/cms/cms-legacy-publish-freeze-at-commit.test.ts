import { CustomApiCompliantException } from '@/exceptions';
import { PROFILE_CMS_FROZEN_CODE } from '@/profile-cms/profile-cms-identity-freeze';
import { CmsDb, CmsPublishedPackageRow } from './cms.db';
import {
  clearFreezeSettings,
  expectCommitted,
  fakeTransactionalDb,
  freezeClock,
  settle
} from '@/tests/fixtures/freeze-at-commit.fixture';
import { SqlExecutor } from '@/sql-executor';
import { Time } from '@/time';

function packageRow(): CmsPublishedPackageRow {
  return {
    package_hash: 'a'.repeat(64),
    payload_hash: 'b'.repeat(64),
    schema: 'cms.v1',
    site_id: 'site-1',
    owner_profile_id: 'profile-1',
    title: 'Title',
    description: null,
    static_path: '/site/index.html',
    canonical_url: null,
    package_json: {},
    storage_json: {},
    signature_json: {},
    published_at: 1,
    published_by_wallet: '0x0000000000000000000000000000000000006529'
  } as unknown as CmsPublishedPackageRow;
}

function cmsDbOnFakeTransaction(onWrite: () => void = () => undefined) {
  const fake = fakeTransactionalDb();
  // Records each write in the transaction's statements, then lets the test
  // move the clock: a write that waited past the freeze.
  const execute = jest.fn(async (sql: string) => {
    fake.statements.push(/^\s*INSERT/i.test(sql) ? 'INSERT' : 'UPDATE');
    onWrite();
    return [];
  });
  const db = {
    execute,
    executeNativeQueriesInTransaction: fake.executeNativeQueriesInTransaction
  } as unknown as SqlExecutor;
  return { cmsDb: new CmsDb(() => db), statements: fake.statements };
}

describe('legacy CMS publish: the freeze checked again at commit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rolls a publish back with 423 IDENTITY_FROZEN when its commit comes after the freeze', async () => {
    const clock = freezeClock();
    try {
      // The clock passes the freeze during the writes, so only a check made
      // after them, at COMMIT, sees it.
      const { cmsDb, statements } = cmsDbOnFakeTransaction(() => clock.pass());
      const check = jest.fn(() => {
        if (Time.currentMillis() >= clock.T) {
          throw new CustomApiCompliantException(
            423,
            "Legacy CMS sites can't change while profiles move to the 6529 Network.",
            PROFILE_CMS_FROZEN_CODE
          );
        }
      });
      const { error } = await settle(
        cmsDb.publishPackage(packageRow(), true, check)
      );
      expect(check).toHaveBeenCalledTimes(1);
      expect((error as CustomApiCompliantException).getStatusCode()).toBe(423);
      expect(statements[0]).toBe('BEGIN');
      expect(statements).toContain('INSERT');
      expect(statements).not.toContain('COMMIT');
      expect(statements.slice(-2)).toEqual(['ROLLBACK', 'RELEASE']);
      expect(statements.indexOf('ROLLBACK')).toBeGreaterThan(
        statements.lastIndexOf('INSERT')
      );
    } finally {
      clock.restore();
    }
  });

  it('commits a publish whose check passes, and runs no check without one', async () => {
    const restore = clearFreezeSettings();
    try {
      const withCheck = cmsDbOnFakeTransaction();
      const check = jest.fn();
      await withCheck.cmsDb.publishPackage(packageRow(), true, check);
      expect(check).toHaveBeenCalledTimes(1);
      expectCommitted(withCheck.statements);

      const without = cmsDbOnFakeTransaction();
      await without.cmsDb.publishPackage(packageRow(), true);
      expectCommitted(without.statements);
    } finally {
      restore();
    }
  });
});
