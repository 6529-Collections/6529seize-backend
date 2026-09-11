import { createHash, timingSafeEqual } from 'node:crypto';
import {
  PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE,
  PUSH_NOTIFICATION_DEVICES_TABLE,
  PUSH_NOTIFICATION_SETTINGS_TABLE,
  WALLET_AUTH_SESSIONS_TABLE
} from '@/constants';
import { PushInstallationEntity } from '@/entities/IPushInstallation';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { hashSecret } from '@/api/auth/auth-session-v2';

export interface InstallationProof {
  device_id: string;
  installation_secret?: string;
  token?: string;
}
export interface InstallationRevocation extends InstallationProof {
  installation_secret: string;
  revision: number;
  all_profiles: boolean;
  profile_id?: string;
  sessions: { address: string; native_refresh_token: string }[];
}
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const conflict = () =>
  new CustomApiCompliantException(409, 'Stale push installation revision');

/** Every registration/revocation locks the same durable row, including legacy clients. */
async function lockInstallation(proof: InstallationProof, ctx: RequestContext) {
  const options = { wrappedConnection: ctx.connection };
  await sqlExecutor.execute(
    `INSERT IGNORE INTO ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} (device_id, revision) VALUES (:device_id, 0)`,
    { device_id: proof.device_id },
    options
  );
  const installation = await sqlExecutor.oneOrNull<PushInstallationEntity>(
    `SELECT * FROM ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} WHERE device_id = :device_id FOR UPDATE`,
    { device_id: proof.device_id },
    options
  );
  if (!installation) throw new Error('Push installation lock failed');
  if (installation.secret_hash) {
    if (
      !proof.installation_secret ||
      !timingSafeEqual(
        Buffer.from(installation.secret_hash, 'hex'),
        Buffer.from(digest(proof.installation_secret), 'hex')
      )
    )
      throw new ForbiddenException('Invalid push installation credential');
  } else if (proof.installation_secret) {
    const legacy = await sqlExecutor.execute<PushNotificationDevice>(
      `SELECT * FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} WHERE device_id = :device_id FOR UPDATE`,
      { device_id: proof.device_id },
      options
    );
    // Device IDs are public to registered profiles. A caller must know the
    // existing FCM token, and cannot add its own token row to claim others.
    if (legacy.some((row) => !proof.token || row.token !== proof.token)) {
      throw new ForbiddenException(
        'Legacy installation token ownership is ambiguous'
      );
    }
    installation.secret_hash = digest(proof.installation_secret);
    installation.token = legacy[0]?.token ?? proof.token ?? null;
    installation.platform = legacy[0]?.platform ?? null;
    await sqlExecutor.execute(
      `UPDATE ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} SET secret_hash = :secret_hash, token = :token, platform = :platform WHERE device_id = :device_id`,
      { ...installation },
      options
    );
  }
  return installation;
}

export async function registerInstallationDevice(
  device: PushNotificationDevice,
  credential: { installation_secret?: string; installation_revision?: number },
  ctx: RequestContext
): Promise<void> {
  const timer = 'PushInstallationDb->register';
  ctx.timer?.start(timer);
  try {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      const installation = await lockInstallation(
        { ...device, ...credential },
        { ...ctx, connection }
      );
      if (
        installation.secret_hash &&
        credential.installation_revision !== installation.revision
      )
        throw conflict();
      const options = { wrappedConnection: connection };
      await sqlExecutor.execute(
        `INSERT INTO ${PUSH_NOTIFICATION_DEVICES_TABLE} (device_id, token, profile_id, platform)
         VALUES (:device_id, :token, :profile_id, :platform)
         ON DUPLICATE KEY UPDATE token = VALUES(token), platform = VALUES(platform)`,
        { ...device, platform: device.platform ?? null },
        options
      );
      await sqlExecutor.execute(
        `UPDATE ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} SET token = :token, platform = :platform WHERE device_id = :device_id`,
        {
          device_id: device.device_id,
          token: device.token,
          platform: device.platform ?? null
        },
        options
      );
    });
  } finally {
    ctx.timer?.stop(timer);
  }
}

export async function revokeInstallation(
  request: InstallationRevocation,
  ctx: RequestContext
): Promise<PushInstallationEntity> {
  const timer = 'PushInstallationDb->revoke';
  ctx.timer?.start(timer);
  try {
    return await sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        const installation = await lockInstallation(request, {
          ...ctx,
          connection
        });
        // A retry must never delete a profile deliberately reconnected later.
        if (request.revision <= installation.revision) return installation;
        if (request.revision !== installation.revision + 1) throw conflict();
        const options = { wrappedConnection: connection };
        const scope = request.all_profiles
          ? ''
          : ' AND profile_id = :profile_id';
        const params = {
          device_id: request.device_id,
          profile_id: request.profile_id
        };
        if (request.all_profiles || request.profile_id) {
          await sqlExecutor.execute(
            `DELETE FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} WHERE device_id = :device_id${scope}`,
            params,
            options
          );
          await sqlExecutor.execute(
            `DELETE FROM ${PUSH_NOTIFICATION_SETTINGS_TABLE} WHERE device_id = :device_id${scope}`,
            params,
            options
          );
        }
        // Possession of each refresh token authorizes only that exact native
        // session. Never revoke the address's sessions on other installations.
        for (const session of request.sessions) {
          await sqlExecutor.execute(
            `UPDATE ${WALLET_AUTH_SESSIONS_TABLE} SET revoked_at = COALESCE(revoked_at, :now)
           WHERE address = :address AND refresh_token_hash = :hash AND client_type = 'native'`,
            {
              address: session.address.toLowerCase(),
              hash: hashSecret(session.native_refresh_token),
              now: new Date()
            },
            options
          );
        }
        await sqlExecutor.execute(
          `UPDATE ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} SET revision = :revision WHERE device_id = :device_id`,
          { device_id: request.device_id, revision: request.revision },
          options
        );
        return { ...installation, revision: request.revision };
      }
    );
  } finally {
    ctx.timer?.stop(timer);
  }
}
