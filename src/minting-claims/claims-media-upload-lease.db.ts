import { randomUUID } from 'node:crypto';
import { MINTING_CLAIMS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

// Longer than the worker's maximum 900-second execution. A timed-out worker
// cannot overlap a normal takeover; a crashed owner never leaves a permanent lock.
export const CLAIM_MEDIA_UPLOAD_LEASE_MS = 20 * 60 * 1000;
const DB_NOW = 'CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED)';
const PRIMARY = { forcePool: DbPoolName.WRITE };

export interface ClaimMediaUploadLease {
  contract: string;
  claimId: number;
  token: string;
}

export interface ClaimMediaUploadCheckpoint {
  image_location?: string;
  animation_location?: string | null;
  metadata_location?: string;
  media_uploading?: boolean;
}

export class ClaimMediaUploadLeaseLostError extends Error {
  constructor() {
    super('Claim media upload ownership was lost; retry required');
    this.name = 'ClaimMediaUploadLeaseLostError';
    Object.setPrototypeOf(this, ClaimMediaUploadLeaseLostError.prototype);
  }
}

export class ClaimsMediaUploadLeaseDb extends LazyDbAccessCompatibleService {
  async acquire(
    contract: string,
    claimId: number
  ): Promise<ClaimMediaUploadLease | null> {
    const lease = {
      contract: contract.toLowerCase(),
      claimId,
      token: randomUUID()
    };
    const result = await this.db.execute(
      `UPDATE ${MINTING_CLAIMS_TABLE}
       SET media_upload_lease_token = :token,
           media_upload_lease_until = ${DB_NOW} + :duration
       WHERE contract = :contract AND claim_id = :claimId
         AND media_uploading = 1
         AND (media_upload_lease_until IS NULL OR media_upload_lease_until <= ${DB_NOW})`,
      { ...lease, duration: CLAIM_MEDIA_UPLOAD_LEASE_MS },
      PRIMARY
    );
    return this.db.getAffectedRows(result) === 1 ? lease : null;
  }

  async assertHeld(lease: ClaimMediaUploadLease): Promise<void> {
    const row = await this.db.oneOrNull<{ held: number }>(
      `SELECT 1 AS held FROM ${MINTING_CLAIMS_TABLE}
       WHERE contract = :contract AND claim_id = :claimId
         AND media_upload_lease_token = :token
         AND media_upload_lease_until > ${DB_NOW}`,
      { ...lease },
      PRIMARY
    );
    if (!row) throw new ClaimMediaUploadLeaseLostError();
  }

  async update(
    lease: ClaimMediaUploadLease,
    checkpoint: ClaimMediaUploadCheckpoint
  ): Promise<void> {
    const columns = [
      'image_location',
      'animation_location',
      'metadata_location',
      'media_uploading'
    ] as const;
    const assignments = columns
      .filter((key) => checkpoint[key] !== undefined)
      .map((key) => `${key} = :${key}`);
    if (!assignments.length) return;
    if (checkpoint.media_uploading === false) {
      assignments.push(
        'media_upload_lease_token = NULL',
        'media_upload_lease_until = NULL'
      );
    }
    const result = await this.db.execute(
      `UPDATE ${MINTING_CLAIMS_TABLE} SET ${assignments.join(', ')}
       WHERE contract = :contract AND claim_id = :claimId
         AND media_upload_lease_token = :token
         AND media_upload_lease_until > ${DB_NOW}`,
      { ...lease, ...checkpoint },
      PRIMARY
    );
    // A repeated checkpoint may be unchanged. It is safe only while still owned.
    if (this.db.getAffectedRows(result) !== 1) await this.assertHeld(lease);
  }

  async release(lease: ClaimMediaUploadLease): Promise<void> {
    await this.db.execute(
      `UPDATE ${MINTING_CLAIMS_TABLE}
       SET media_upload_lease_token = NULL, media_upload_lease_until = NULL
       WHERE contract = :contract AND claim_id = :claimId
         AND media_upload_lease_token = :token`,
      { ...lease },
      PRIMARY
    );
  }
}

export const claimsMediaUploadLeaseDb = new ClaimsMediaUploadLeaseDb(
  dbSupplier
);
