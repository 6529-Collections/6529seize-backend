import 'reflect-metadata';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import {
  PUSH_NOTIFICATION_DEVICES_TABLE,
  PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE,
  WALLET_AUTH_SESSIONS_TABLE
} from '@/constants';
import {
  registerInstallationDevice,
  revokeInstallation
} from './push-installation.db';
import { hashSecret } from '@/api/auth/auth-session-v2';

const secret = 'a'.repeat(64);
const credential = { installation_secret: secret, installation_revision: 0 };
const device = (profile: string, deviceId = 'phone') => ({
  device_id: deviceId,
  token: 'fcm-token',
  platform: 'ios',
  profile_id: profile
});
const revoke = (revision: number, profile_id?: string) =>
  revokeInstallation(
    {
      device_id: 'phone',
      installation_secret: secret,
      revision,
      all_profiles: profile_id === undefined,
      ...(profile_id ? { profile_id } : {}),
      sessions: []
    },
    {}
  );
const registrations = () =>
  sqlExecutor.execute<{ device_id: string; profile_id: string }>(
    `SELECT device_id, profile_id FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} ORDER BY device_id, profile_id`
  );

describeWithSeed('push installation logout', [], () => {
  it('removes A from this phone, preserving B and another device', async () => {
    await registerInstallationDevice(device('A'), credential, {});
    await registerInstallationDevice(device('B'), credential, {});
    await registerInstallationDevice(
      device('A', 'other-phone'),
      credential,
      {}
    );
    await revoke(1, 'A');
    expect(await registrations()).toEqual([
      { device_id: 'other-phone', profile_id: 'A' },
      { device_id: 'phone', profile_id: 'B' }
    ]);
  });

  it('all-profile logout sweeps stale profiles and retains the final badge target', async () => {
    await registerInstallationDevice(device('A'), credential, {});
    await registerInstallationDevice(
      device('forgotten-profile'),
      credential,
      {}
    );
    const result = await revoke(1);
    expect(await registrations()).toEqual([]);
    expect(result).toMatchObject({
      token: 'fcm-token',
      platform: 'ios',
      revision: 1
    });
    expect(
      await sqlExecutor.execute(
        `SELECT * FROM ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE}`
      )
    ).toHaveLength(1);
  });

  it('rejects late registration and idempotent logout retries preserve later sign-ins', async () => {
    await registerInstallationDevice(device('A'), credential, {});
    await revoke(1);
    await expect(
      registerInstallationDevice(device('A'), credential, {})
    ).rejects.toThrow('Stale');
    await expect(
      registerInstallationDevice(device('A'), {}, {})
    ).rejects.toThrow('credential');
    await registerInstallationDevice(
      device('A'),
      { ...credential, installation_revision: 1 },
      {}
    );
    await revoke(1);
    expect(await registrations()).toEqual([
      { device_id: 'phone', profile_id: 'A' }
    ]);
  });

  it('rejects a device ID without its credential and out-of-order revisions', async () => {
    await registerInstallationDevice(device('A'), credential, {});
    await expect(
      revokeInstallation(
        {
          device_id: 'phone',
          installation_secret: 'b'.repeat(64),
          revision: 1,
          all_profiles: true,
          sessions: []
        },
        {}
      )
    ).rejects.toThrow('credential');
    await expect(revoke(2)).rejects.toThrow('Stale');
    expect(await registrations()).toHaveLength(1);
  });

  it('claims matching legacy registrations but rejects ambiguous token ownership', async () => {
    await registerInstallationDevice(device('A'), {}, {});
    await registerInstallationDevice(device('B'), {}, {});
    await registerInstallationDevice(device('A'), credential, {});
    await revoke(1);
    expect(await registrations()).toEqual([]);
    await registerInstallationDevice(device('A', 'legacy'), {}, {});
    await registerInstallationDevice(
      { ...device('B', 'legacy'), token: 'another-token' },
      {},
      {}
    );
    await expect(
      registerInstallationDevice(device('A', 'legacy'), credential, {})
    ).rejects.toThrow('ambiguous');
    expect(await registrations()).toHaveLength(2);
  });

  it('revokes only supplied native refresh sessions, not other devices or web sessions', async () => {
    process.env.AUTH_SESSION_HASH_SECRET = 'push-logout-test-secret';
    const address = '0x' + '1'.repeat(40);
    await registerInstallationDevice(device('A'), credential, {});
    for (const [id, token, client] of [
      ['this-native', 'this-token', 'native'],
      ['other-native', 'other-token', 'native'],
      ['web', 'web-token', 'web']
    ]) {
      await sqlExecutor.execute(
        `INSERT INTO ${WALLET_AUTH_SESSIONS_TABLE} (id, address, client_type, refresh_token_hash, expires_at) VALUES (:id, :address, :client, :hash, :expires)`,
        {
          id,
          address,
          client,
          hash: hashSecret(token),
          expires: new Date(Date.now() + 60000)
        }
      );
    }
    await revokeInstallation(
      {
        device_id: 'phone',
        installation_secret: secret,
        revision: 1,
        all_profiles: true,
        sessions: [
          { address, native_refresh_token: 'this-token' },
          { address, native_refresh_token: 'web-token' }
        ]
      },
      {}
    );
    const sessions = await sqlExecutor.execute<{
      id: string;
      revoked_at: Date | null;
    }>(`SELECT id, revoked_at FROM ${WALLET_AUTH_SESSIONS_TABLE}`);
    expect(
      sessions
        .filter((session) => session.revoked_at !== null)
        .map((session) => session.id)
    ).toEqual(['this-native']);
  });

  it('serializes concurrent registration against logout without resurrection', async () => {
    await registerInstallationDevice(device('A'), credential, {});
    const outcomes = await Promise.allSettled([
      registerInstallationDevice(device('B'), credential, {}),
      revoke(1)
    ]);
    expect(outcomes[1].status).toBe('fulfilled');
    expect(await registrations()).toEqual([]);
  });
  it.each([false, true])(
    'serializes concurrent registration with existing installation=%s',
    async (existing) => {
      if (existing)
        await registerInstallationDevice(device('initial'), credential, {});
      await Promise.all(
        ['A', 'B', 'C', 'D'].map((profile) =>
          registerInstallationDevice(device(profile), credential, {})
        )
      );
      expect(await registrations()).toHaveLength(existing ? 5 : 4);
    }
  );

  it('claims a legacy installation during logout using its token proof', async () => {
    await registerInstallationDevice(device('A'), {}, {});
    await registerInstallationDevice(device('B'), {}, {});
    await expect(revoke(1)).rejects.toThrow('ambiguous');
    expect(await registrations()).toHaveLength(2);
    const result = await revokeInstallation(
      {
        device_id: 'phone',
        installation_secret: secret,
        token: 'fcm-token',
        revision: 1,
        all_profiles: true,
        sessions: []
      },
      {}
    );
    expect(await registrations()).toEqual([]);
    expect(result).toMatchObject({
      revision: 1,
      token: 'fcm-token',
      platform: 'ios'
    });
    expect(result.secret_hash).toHaveLength(64);
  });
});
