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

export const saveEULAConsent = async (
  deviceId: string,
  platform: string,
  eulaVersion: string
) => {
  const acceptedAt = Time.now().toMillis();
  await sqlExecutor.execute(
    `INSERT INTO ${EULA_CONSENT_TABLE} (device_id, platform, accepted_at, eula_version)
      VALUES (:deviceId, :platform, :acceptedAt, :eulaVersion)
      ON DUPLICATE KEY UPDATE
        platform = :platform,
        accepted_at = :acceptedAt,
        eula_version = :eulaVersion
    `,
    { deviceId, platform, acceptedAt, eulaVersion }
  );
};

export const deleteEULAConsent = async (deviceId: string) => {
  await sqlExecutor.execute(
    `DELETE FROM ${EULA_CONSENT_TABLE} WHERE device_id = :deviceId`,
    { deviceId }
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
