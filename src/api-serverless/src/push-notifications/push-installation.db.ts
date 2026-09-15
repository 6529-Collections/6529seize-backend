import { createHash, timingSafeEqual } from 'node:crypto';
import {
  PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE,
  PUSH_NOTIFICATION_DEVICES_TABLE,
  PUSH_NOTIFICATION_SETTINGS_TABLE,
  PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE
} from '@/constants';
import { PushInstallationEntity } from '@/entities/IPushInstallation';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import {
  requireLiveNativeSession,
  revokeNativeSessions
} from './push-logout-sessions';

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
// Clients generate high-entropy installation credentials from two UUIDv4s;
// these are random bearer credentials, not user-chosen passwords.
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
/** Compare legacy ownership proofs without exposing token prefixes or throwing on unequal lengths. */
function matchesToken(stored: string, provided: string | undefined): boolean {
  if (!provided) return false;
  return timingSafeEqual(
    Buffer.from(digest(stored), 'hex'),
    Buffer.from(digest(provided), 'hex')
  );
}
const conflict = () =>
  new CustomApiCompliantException(409, 'Stale push installation revision');

type InstallationOperation = 'registration' | 'revocation';

// The installation row already serializes this read; avoid missing-key gap locks.
async function getLogoutFence(proof: InstallationProof, ctx: RequestContext) {
  return sqlExecutor.oneOrNull<{ revision: number }>(
    `SELECT revision FROM ${PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE}
     WHERE device_id = :device_id AND secret_hash = :secret_hash`,
    {
      device_id: proof.device_id,
      secret_hash: digest(proof.installation_secret!)
    },
    { wrappedConnection: ctx.connection }
  );
}

/** Every registration/revocation locks the same durable row, including legacy clients. */
async function lockInstallation(
  proof: InstallationProof,
  ctx: RequestContext,
  operation: InstallationOperation
) {
  if (!ctx.connection?.connection) {
    throw new Error('Push installation locks require a transaction connection');
  }
  const options = { wrappedConnection: ctx.connection };
  // Create the row when absent; the explicit locking read below fences every
  // existing-row claim regardless of whether the duplicate-key update changes it.
  await sqlExecutor.execute(
    `INSERT INTO ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} (device_id, revision) VALUES (:device_id, 0)
     ON DUPLICATE KEY UPDATE device_id = VALUES(device_id)`,
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
      `SELECT * FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} WHERE device_id = :device_id ORDER BY profile_id FOR UPDATE`,
      { device_id: proof.device_id },
      options
    );
    // No existing registration means no proof of ownership of this device ID.
    // Early logout may only fence its own secret; authenticated registration
    // remains free to establish the installation using a different credential.
    if (!legacy.length && !installation.token && operation === 'revocation') {
      return installation;
    }
    // Device IDs are public to registered profiles. A caller must know the
    // existing FCM token, and cannot add its own token row to claim others.
    const retainedTokenMismatch =
      !legacy.length &&
      installation.token &&
      !matchesToken(installation.token, proof.token);
    if (
      retainedTokenMismatch ||
      legacy.some((row) => !matchesToken(row.token, proof.token))
    ) {
      throw new ForbiddenException(
        'Legacy installation token ownership is ambiguous'
      );
    }
    const fence = await getLogoutFence(proof, ctx);
    installation.revision = fence?.revision ?? installation.revision;
    installation.secret_hash = digest(proof.installation_secret);
    installation.token =
      legacy[0]?.token ?? installation.token ?? proof.token ?? null;
    installation.platform =
      legacy[0]?.platform ?? installation.platform ?? null;
    await sqlExecutor.execute(
      `UPDATE ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} SET secret_hash = :secret_hash, token = :token, platform = :platform, revision = :revision WHERE device_id = :device_id`,
      { ...installation },
      options
    );
    // The authoritative installation now owns this credential's revision fence.
    await sqlExecutor.execute(
      `DELETE FROM ${PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE}
       WHERE device_id = :device_id AND secret_hash = :secret_hash`,
      { device_id: proof.device_id, secret_hash: installation.secret_hash },
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
        { ...ctx, connection },
        'registration'
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
): Promise<Pick<PushInstallationEntity, 'device_id' | 'revision'>> {
  const timer = 'PushInstallationDb->revoke';
  ctx.timer?.start(timer);
  try {
    const revoked = await sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        const installation = await lockInstallation(
          request,
          { ...ctx, connection },
          'revocation'
        );
        const transactionCtx = { ...ctx, connection };
        if (!installation.secret_hash) {
          return revokeBeforeRegistration(request, transactionCtx);
        }
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
        await revokeNativeSessions(request.sessions, transactionCtx);
        await sqlExecutor.execute(
          `UPDATE ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} SET revision = :revision WHERE device_id = :device_id`,
          { device_id: request.device_id, revision: request.revision },
          options
        );
        return { ...installation, revision: request.revision };
      }
    );
    // Keep the verifier and delivery token inside the persistence boundary,
    // including on the idempotent retry path.
    return { device_id: revoked.device_id, revision: revoked.revision };
  } finally {
    ctx.timer?.stop(timer);
  }
}

/** Caller holds the shared installation row lock, but this row grants no ownership. */
async function revokeBeforeRegistration(
  request: InstallationRevocation,
  ctx: RequestContext
): Promise<Pick<PushInstallationEntity, 'device_id' | 'revision'>> {
  const fence = await getLogoutFence(request, ctx);
  if (!fence) await requireLiveNativeSession(request.sessions, ctx);
  const currentRevision = fence?.revision ?? 0;
  if (request.revision <= currentRevision) {
    return { device_id: request.device_id, revision: currentRevision };
  }
  if (request.revision !== currentRevision + 1) throw conflict();
  await revokeNativeSessions(request.sessions, ctx);
  await sqlExecutor.execute(
    `INSERT INTO ${PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE} (device_id, secret_hash, revision)
     VALUES (:device_id, :secret_hash, :revision)
     ON DUPLICATE KEY UPDATE revision = VALUES(revision)`,
    {
      device_id: request.device_id,
      secret_hash: digest(request.installation_secret),
      revision: request.revision
    },
    { wrappedConnection: ctx.connection }
  );
  return { device_id: request.device_id, revision: request.revision };
}
