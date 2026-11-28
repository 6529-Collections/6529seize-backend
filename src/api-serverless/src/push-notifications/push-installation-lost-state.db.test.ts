import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import {
  PUSH_NOTIFICATION_DEVICES_TABLE,
  PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE,
  PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE,
  PUSH_NOTIFICATION_SETTINGS_TABLE,
  WALLET_AUTH_SESSIONS_TABLE
} from '@/constants';
import { hashSecret } from '@/api/auth/auth-session-v2';
import {
  registerInstallationDevice,
  revokeInstallation
} from './push-installation.db';

// Push device rows and sign-in sessions are ephemeral: an empty table must
// not leave a phone unable to register, or its queued logout stuck forever.
// These tests empty the tables the way a rebuild would and replay what an
// installed app sends next. PUSH_INSTALLATION_ADOPT_REVISION gates the fix.

const FLAG = 'PUSH_INSTALLATION_ADOPT_REVISION';
const secret = 'a'.repeat(64);
const otherSecret = 'b'.repeat(64);
const address = '0x' + '6'.repeat(40);
const device = (profile: string, token = 'fcm-token') => ({
  device_id: 'phone',
  token,
  platform: 'ios',
  profile_id: profile
});
const register = (revision: number, profile = 'A', token?: string) =>
  registerInstallationDevice(
    device(profile, token),
    { installation_secret: secret, installation_revision: revision },
    {}
  );
type Sessions = { address: string; native_refresh_token: string }[];
const logout = (
  revision: number,
  extra: {
    sessions?: Sessions;
    reconciliation_sessions?: Sessions;
    token?: string;
    token_scoped?: boolean;
  } = {}
) =>
  revokeInstallation(
    {
      device_id: 'phone',
      installation_secret: secret,
      revision,
      all_profiles: true,
      sessions: extra.sessions ?? [],
      ...(extra.reconciliation_sessions
        ? { reconciliation_sessions: extra.reconciliation_sessions }
        : {}),
      ...(extra.token ? { token: extra.token } : {}),
      ...(extra.token_scoped ? { token_scoped: true } : {})
    },
    {}
  );
const sessionRevoked = (token: string) =>
  sqlExecutor.oneOrNull<{ revoked: number }>(
    `SELECT revoked_at IS NOT NULL AS revoked FROM ${WALLET_AUTH_SESSIONS_TABLE} WHERE id = :id`,
    { id: `session-${token}` }
  );
const registrations = () =>
  sqlExecutor.execute<{ profile_id: string }>(
    `SELECT profile_id FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} WHERE device_id = 'phone' ORDER BY profile_id`
  );
const installation = () =>
  sqlExecutor.oneOrNull<{ secret_hash: string | null; revision: number }>(
    `SELECT secret_hash, revision FROM ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} WHERE device_id = 'phone'`
  );
const installationWithToken = () =>
  sqlExecutor.oneOrNull<{
    secret_hash: string | null;
    revision: number;
    token: string | null;
  }>(
    `SELECT secret_hash, revision, token FROM ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} WHERE device_id = 'phone'`
  );
const fences = () =>
  sqlExecutor.execute<{ revision: number }>(
    `SELECT revision FROM ${PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE} WHERE device_id = 'phone'`
  );
const emptyTables = async (tables: readonly string[]) => {
  for (const table of tables) {
    await sqlExecutor.execute(`TRUNCATE TABLE ${table}`);
  }
};
const ALL_TABLES = [
  PUSH_NOTIFICATION_SETTINGS_TABLE,
  PUSH_NOTIFICATION_DEVICES_TABLE,
  PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE,
  PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE,
  WALLET_AUTH_SESSIONS_TABLE
];
const PUSH_TABLES = [
  PUSH_NOTIFICATION_DEVICES_TABLE,
  PUSH_NOTIFICATION_DEVICE_LOGOUT_FENCES_TABLE,
  PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE
];
const liveSession = async (token: string) => {
  await sqlExecutor.execute(
    `INSERT INTO ${WALLET_AUTH_SESSIONS_TABLE} (id, address, client_type, refresh_token_hash, expires_at)
     VALUES (:id, :address, 'native', :hash, :expires)`,
    {
      id: `session-${token}`,
      address,
      hash: hashSecret(token),
      expires: new Date(Date.now() + 600000)
    }
  );
  return [{ address, native_refresh_token: token }];
};

/** A phone that signed in, out and in again holds revision 2. */
async function phoneAtRevisionTwo() {
  await register(0);
  await logout(1);
  await register(1);
  await logout(2);
  await register(2);
  expect(await installation()).toMatchObject({ revision: 2 });
}

describe('push installations after their tables are emptied', () => {
  const originalFlag = process.env[FLAG];
  beforeEach(async () => {
    process.env.AUTH_SESSION_HASH_SECRET = 'push-lost-state-test-secret';
    await emptyTables(ALL_TABLES);
  });
  afterEach(async () => {
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
    await emptyTables(ALL_TABLES);
  });

  describe('with the flag off (today)', () => {
    beforeEach(() => {
      delete process.env[FLAG];
    });

    it('refuses every registration from a phone past revision 0', async () => {
      await phoneAtRevisionTwo();
      await emptyTables(PUSH_TABLES);
      await expect(register(2)).rejects.toThrow('Stale');
      await expect(register(2)).rejects.toThrow('Stale');
      expect(await registrations()).toEqual([]);
    });

    it('keeps a queued logout for an unknown installation failing', async () => {
      await expect(logout(3)).rejects.toThrow('native session');
      const sessions = await liveSession('proof');
      await expect(logout(3, { sessions })).rejects.toThrow('Stale');
    });
  });

  describe('with the flag on', () => {
    beforeEach(() => {
      process.env[FLAG] = 'true';
    });

    it('lets the phone register again at its own revision', async () => {
      await phoneAtRevisionTwo();
      await emptyTables(PUSH_TABLES);
      await register(2);
      expect(await registrations()).toEqual([{ profile_id: 'A' }]);
      expect(await installation()).toEqual({
        secret_hash: expect.any(String),
        revision: 2
      });
      // From here the stored revision is exact again: an older retry is stale.
      await expect(register(1)).rejects.toThrow('Stale');
      await register(2, 'B');
      expect(await registrations()).toEqual([
        { profile_id: 'A' },
        { profile_id: 'B' }
      ]);
    });

    it('still refuses a registration older than a fence that survived', async () => {
      const sessions = await liveSession('proof');
      // Early logout before any registration fences this credential at 2.
      await logout(2, { sessions });
      expect(await fences()).toEqual([{ revision: 2 }]);
      await expect(register(1)).rejects.toThrow('Stale');
      expect(await registrations()).toEqual([]);
      await register(2);
      expect(await registrations()).toEqual([{ profile_id: 'A' }]);
      expect(await fences()).toEqual([]);
    });

    it('clears a queued logout once the app signs in again, at the skipped revision', async () => {
      await phoneAtRevisionTwo();
      await emptyTables(ALL_TABLES);
      // The app queued this logout; its session row is gone too. Without a
      // proof it is refused, and nothing is written, as today.
      await expect(logout(3)).rejects.toThrow('native session');
      expect(await installation()).toBeNull();
      // After the person signs in again the app retries with the fresh
      // session as reconciliation proof (the client's existing path).
      const fresh = await liveSession('fresh');
      expect(await logout(3, { reconciliation_sessions: fresh })).toEqual({
        device_id: 'phone',
        revision: 3
      });
      expect(await fences()).toEqual([{ revision: 3 }]);
      expect(await sessionRevoked('fresh')).toEqual({ revoked: 0 });
      // The queue is clear, so the app registers at its next start.
      await expect(register(2)).rejects.toThrow('Stale');
      await register(3);
      expect(await registrations()).toEqual([{ profile_id: 'A' }]);
      expect(await installation()).toMatchObject({ revision: 3 });
    });

    it('fences a proven logout that skips revisions the server lost', async () => {
      await phoneAtRevisionTwo();
      await emptyTables(PUSH_TABLES);
      const sessions = await liveSession('proof');
      expect(await logout(4, { sessions })).toEqual({
        device_id: 'phone',
        revision: 4
      });
      expect(await fences()).toEqual([{ revision: 4 }]);
      await expect(register(3)).rejects.toThrow('Stale');
      await register(4);
      expect(await registrations()).toEqual([{ profile_id: 'A' }]);
    });

    it('lets a logout claim registrations that outlived their installation row', async () => {
      await phoneAtRevisionTwo();
      await emptyTables([PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE]);
      expect(await registrations()).toEqual([{ profile_id: 'A' }]);
      expect(await logout(3, { token: 'fcm-token' })).toEqual({
        device_id: 'phone',
        revision: 3
      });
      expect(await registrations()).toEqual([]);
      expect(await installation()).toMatchObject({ revision: 3 });
      await expect(register(2)).rejects.toThrow('Stale');
    });

    it('acknowledges a proofless token cleanup that matches no row, writing nothing', async () => {
      await emptyTables(ALL_TABLES);
      expect(
        await logout(1, { token: 'gone-token', token_scoped: true })
      ).toEqual({ device_id: 'phone', revision: 1 });
      // Nothing is written, not even the row the lock inserts.
      expect(await fences()).toEqual([]);
      expect(await installation()).toBeNull();
    });

    it('gives the same answer when the device has other rows, and removes nothing', async () => {
      await register(0);
      const before = await installationWithToken();
      expect(
        await logout(1, { token: 'another-token', token_scoped: true })
      ).toEqual({ device_id: 'phone', revision: 1 });
      expect(await registrations()).toEqual([{ profile_id: 'A' }]);
      expect(await fences()).toEqual([]);
      expect(await installationWithToken()).toEqual(before);
    });

    it.each(['FCM-token', 'fcm-token-extra'])(
      'acknowledges a cleanup with the similar token %s but removes nothing',
      async (token) => {
        await register(0);
        expect(
          await revokeInstallation(
            {
              device_id: 'phone',
              installation_secret: otherSecret,
              revision: 1,
              token,
              token_scoped: true,
              all_profiles: true,
              sessions: []
            },
            {}
          )
        ).toEqual({ device_id: 'phone', revision: 1 });
        expect(await registrations()).toEqual([{ profile_id: 'A' }]);
      }
    );

    it('still refuses a token cleanup without a token', async () => {
      await register(0);
      await expect(
        revokeInstallation(
          {
            device_id: 'phone',
            installation_secret: otherSecret,
            revision: 1,
            token_scoped: true,
            all_profiles: true,
            sessions: []
          },
          {}
        )
      ).rejects.toThrow('requires a token');
      expect(await registrations()).toEqual([{ profile_id: 'A' }]);
    });

    it('leaves an installation row that keeps its last token as it was', async () => {
      await register(0);
      await logout(1);
      expect(await registrations()).toEqual([]);
      const before = await installationWithToken();
      expect(before).toMatchObject({ token: 'fcm-token', revision: 1 });
      expect(
        await revokeInstallation(
          {
            device_id: 'phone',
            installation_secret: otherSecret,
            revision: 1,
            token: 'fcm-token',
            token_scoped: true,
            all_profiles: true,
            sessions: []
          },
          {}
        )
      ).toEqual({ device_id: 'phone', revision: 1 });
      expect(await installationWithToken()).toEqual(before);
    });

    it('keeps the token cleanup path strict about revisions', async () => {
      await emptyTables(ALL_TABLES);
      await expect(
        logout(3, { token: 'gone-token', token_scoped: true })
      ).rejects.toThrow('Stale');
    });

    it('lets exactly one of two credentials claim a wiped installation at once', async () => {
      await phoneAtRevisionTwo();
      await emptyTables(ALL_TABLES);
      const results = await Promise.allSettled([
        register(2),
        registerInstallationDevice(
          device('X', 'other-token'),
          { installation_secret: otherSecret, installation_revision: 9 },
          {}
        )
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );
      expect(String(rejected?.reason)).toMatch(/credential/);
      expect(await registrations()).toHaveLength(1);
    });

    it('serializes a re-registration racing a proven logout after a wipe', async () => {
      await phoneAtRevisionTwo();
      await emptyTables(ALL_TABLES);
      const fresh = await liveSession('fresh');
      const [, logoutResult] = await Promise.allSettled([
        register(2),
        logout(3, { reconciliation_sessions: fresh })
      ]);
      // In either order the logout at 3 wins: nothing registered at 2 survives.
      expect(logoutResult.status).toBe('fulfilled');
      expect(await registrations()).toEqual([]);
      await expect(register(2)).rejects.toThrow('Stale');
      await register(3);
      expect(await registrations()).toEqual([{ profile_id: 'A' }]);
    });

    it('keeps an owned installation strict', async () => {
      await phoneAtRevisionTwo();
      // Out of order on a row the server holds is still a conflict.
      await expect(logout(4)).rejects.toThrow('Stale');
      // Another credential still cannot touch it.
      await expect(
        revokeInstallation(
          {
            device_id: 'phone',
            installation_secret: otherSecret,
            revision: 3,
            all_profiles: true,
            sessions: []
          },
          {}
        )
      ).rejects.toThrow('credential');
      await expect(
        registerInstallationDevice(
          device('B'),
          { installation_secret: otherSecret, installation_revision: 9 },
          {}
        )
      ).rejects.toThrow('credential');
      // A retried logout at or below the stored revision changes nothing.
      expect(await logout(2)).toEqual({ device_id: 'phone', revision: 2 });
      expect(await registrations()).toEqual([{ profile_id: 'A' }]);
    });
  });
});
