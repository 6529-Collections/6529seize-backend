import { COOKIES_CONSENT_TABLE } from '../../../constants';
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
