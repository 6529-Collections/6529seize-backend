import { createHash, timingSafeEqual } from 'node:crypto';
import { PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { sqlExecutor } from '@/sql-executor';
import { ApiRefreshPushInstallationBadgeRequest } from '@/api/generated/models/ApiRefreshPushInstallationBadgeRequest';

/** Verify only an established credential; refresh must never claim or alter a device. */
export async function verifyBadgeRefreshInstallation(
  request: ApiRefreshPushInstallationBadgeRequest
): Promise<void> {
  const installation = await sqlExecutor.oneOrNull<{
    secret_hash: string | null;
    revision: number;
  }>(
    `SELECT secret_hash, revision FROM ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} WHERE device_id = :device_id`,
    { device_id: request.device_id },
    { forcePool: DbPoolName.WRITE }
  );
  const stored = Buffer.from(installation?.secret_hash ?? '', 'hex');
  const supplied = createHash('sha256')
    .update(request.installation_secret)
    .digest();
  if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) {
    throw new ForbiddenException('Invalid push installation credential');
  }
  if (installation?.revision !== request.revision) {
    throw new CustomApiCompliantException(
      409,
      'Stale push installation revision'
    );
  }
}
