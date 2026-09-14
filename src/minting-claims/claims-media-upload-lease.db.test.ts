import {
  ClaimsMediaUploadLeaseDb,
  ClaimMediaUploadLeaseLostError,
  CLAIM_MEDIA_UPLOAD_LEASE_MS
} from './claims-media-upload-lease.db';
import { DbPoolName } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';

describe('ClaimsMediaUploadLeaseDb ownership loss', () => {
  it('rejects a checkpoint when the row was taken over', async () => {
    const execute = jest.fn().mockResolvedValue({ affectedRows: 0 });
    const oneOrNull = jest.fn().mockResolvedValue(null);
    const executor = {
      execute,
      oneOrNull,
      getAffectedRows: SqlExecutor.prototype.getAffectedRows
    } as unknown as SqlExecutor;
    const db = new ClaimsMediaUploadLeaseDb(() => executor);
    await expect(
      db.update(
        { contract: 'contract', claimId: 1, token: 'stale-owner' },
        { media_uploading: false }
      )
    ).rejects.toBeInstanceOf(ClaimMediaUploadLeaseLostError);
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      { forcePool: DbPoolName.WRITE }
    );
  });

  it('accepts an unchanged checkpoint only while the same owner is still current', async () => {
    const executor = {
      execute: jest.fn().mockResolvedValue({ affectedRows: 0 }),
      oneOrNull: jest.fn().mockResolvedValue({ held: 1 }),
      getAffectedRows: SqlExecutor.prototype.getAffectedRows
    } as unknown as SqlExecutor;
    const db = new ClaimsMediaUploadLeaseDb(() => executor);
    await expect(
      db.update(
        { contract: 'contract', claimId: 1, token: 'current-owner' },
        { image_location: 'existing-tx' }
      )
    ).resolves.toBeUndefined();
    expect(executor.oneOrNull).toHaveBeenCalledTimes(1);
    expect(CLAIM_MEDIA_UPLOAD_LEASE_MS).toBeGreaterThan(900000 + 30000);
  });
});
