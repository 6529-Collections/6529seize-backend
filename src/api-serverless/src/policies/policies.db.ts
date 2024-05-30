import { COOKIES_CONSENT_TABLE } from '../../../constants';
import { sqlExecutor } from '../../../sql-executor';
import { Time } from '../../../time';

export const isCookiesConsent = async (ip: string): Promise<boolean> => {
  const expiry = Time.now().toMillis();
  const r = await sqlExecutor.execute(
    `SELECT * FROM ${COOKIES_CONSENT_TABLE} WHERE ip = :ip AND expires_at > :expiry`,
    { ip, expiry }
  );
  return r.length > 0;
};

export const setCookiesConsent = async (ip: string) => {
  const acceptedAt = Time.now().toMillis();
  const expiresAt = Time.now().plusDays(30).toMillis();
  await sqlExecutor.execute(
    `INSERT INTO ${COOKIES_CONSENT_TABLE} (ip, accepted_at, expires_at) 
      VALUES (:ip, :acceptedAt, :expiresAt)
      ON DUPLICATE KEY UPDATE accepted_at = :acceptedAt, expires_at = :expiresAt
    `,
    { ip, acceptedAt, expiresAt }
  );
};
