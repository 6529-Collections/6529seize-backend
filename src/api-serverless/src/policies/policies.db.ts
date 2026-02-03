import { COOKIES_CONSENT_TABLE, EULA_CONSENT_TABLE } from '@/constants';
import { sqlExecutor } from '../../../sql-executor';
import { Time } from '../../../time';

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

export const saveEULAConsent = async (deviceId: string, platform: string) => {
  const acceptedAt = Time.now().toMillis();
  await sqlExecutor.execute(
    `INSERT INTO ${EULA_CONSENT_TABLE} (device_id, platform, accepted_at) VALUES (:deviceId, :platform, :acceptedAt)
      ON DUPLICATE KEY UPDATE accepted_at = :acceptedAt
    `,
    { deviceId, platform, acceptedAt }
  );
};

export const deleteEULAConsent = async (deviceId: string) => {
  await sqlExecutor.execute(
    `DELETE FROM ${EULA_CONSENT_TABLE} WHERE device_id = :deviceId`,
    { deviceId }
  );
};

export const fetchEULAConsent = async (deviceId: string) => {
  const result = await sqlExecutor.execute(
    `SELECT * FROM ${EULA_CONSENT_TABLE} WHERE device_id = :deviceId`,
    { deviceId }
  );
  return result[0];
};
