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
    expect(CLAIM_MEDIA_UPLOAD_LEASE_MS).toBe(900000 + 30000);
  });

  it('ties ownership expiry to the actual invocation budget on the writer', async () => {
    const executor = {
      execute: jest.fn().mockResolvedValue({ affectedRows: 1 }),
      getAffectedRows: SqlExecutor.prototype.getAffectedRows
    } as unknown as SqlExecutor;
    const db = new ClaimsMediaUploadLeaseDb(() => executor);
    await db.acquire('0xABC', 1, 180000);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('media_upload_lease_until'),
      expect.objectContaining({ duration: 210000, contract: '0xabc' }),
      { forcePool: DbPoolName.WRITE }
    );
  });

  it('does not load a checkpoint belonging to a replacement owner', async () => {
    const executor = {
      oneOrNull: jest.fn().mockResolvedValue(null)
    } as unknown as SqlExecutor;
    const db = new ClaimsMediaUploadLeaseDb(() => executor);
    await expect(
      db.loadState({ contract: 'c', claimId: 1, token: 'old' })
    ).rejects.toBeInstanceOf(ClaimMediaUploadLeaseLostError);
    expect(executor.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('media_upload_lease_token = :token'),
      expect.objectContaining({ token: 'old' }),
      { forcePool: DbPoolName.WRITE }
    );
  });
});
