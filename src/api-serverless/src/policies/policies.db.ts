import { COOKIES_CONSENT_TABLE, EULA_CONSENT_TABLE } from '@/constants';
import { sqlExecutor } from '../../../sql-executor';
import { Time } from '../../../time';
import { EULAConsent } from '@/entities/IEULAPolicy';
import { CURRENT_EULA_VERSION, EULA_VALIDITY_MS } from './eula-policy';

export const saveCookiesConsent = async (ip: string) => {
  const acceptedAt = Time.now().toMillis();
  await sqlExecutor.execute(
    `INSERT INTO ${COOKIES_CONSENT_TABLE} (ip, accepted_at) 
      VALUES (:ip, :acceptedAt)
      ON DUPLICATE KEY UPDATE accepted_at = :acceptedAt
    `,
    { ip, acceptedAt }
  );
};

export const deleteCookiesConsent = async (ip: string) => {
  await sqlExecutor.execute(
    `DELETE FROM ${COOKIES_CONSENT_TABLE} WHERE ip = :ip`,
    { ip }
  );
};

/**
 * Records a device's EULA acceptance. `profileId` is stored as the owner only
 * when the row is created; re-saving an existing device keeps its owner
 * (including none) and refreshes only the acceptance fields.
 */
export const saveEULAConsent = async (
  deviceId: string,
  platform: string,
  eulaVersion: string,
  profileId: string | null = null
) => {
  const acceptedAt = Time.now().toMillis();
  await sqlExecutor.execute(
    `INSERT INTO ${EULA_CONSENT_TABLE} (device_id, platform, accepted_at, eula_version, profile_id)
      VALUES (:deviceId, :platform, :acceptedAt, :eulaVersion, :profileId)
      ON DUPLICATE KEY UPDATE
        platform = :platform,
        accepted_at = :acceptedAt,
        eula_version = :eulaVersion
    `,
    { deviceId, platform, acceptedAt, eulaVersion, profileId }
  );
};

/**
 * Removes a device's EULA acceptance only when it is owned by `profileId`.
 * Rows with another owner or no owner are left in place.
 */
export const deleteOwnedEULAConsent = async (
  deviceId: string,
  profileId: string
) => {
  await sqlExecutor.execute(
    `DELETE FROM ${EULA_CONSENT_TABLE}
      WHERE device_id = :deviceId
        AND profile_id = :profileId`,
    { deviceId, profileId }
  );
};

export const fetchEULAConsent = async (
  deviceId: string,
  now = Time.now().toMillis()
) => {
  const validAfter = now - EULA_VALIDITY_MS;
  return sqlExecutor.oneOrNull<EULAConsent>(
    `SELECT device_id, platform, accepted_at, eula_version
      FROM ${EULA_CONSENT_TABLE}
      WHERE device_id = :deviceId
        AND eula_version = :eulaVersion
        AND accepted_at >= :validAfter`,
    {
      deviceId,
      eulaVersion: CURRENT_EULA_VERSION,
      validAfter
    }
  );
};
