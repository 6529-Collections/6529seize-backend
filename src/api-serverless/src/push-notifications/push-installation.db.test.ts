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
import { pushNotificationSettingsDb } from './push-notification-settings.db';
import { DEFAULT_PUSH_NOTIFICATION_SETTINGS } from '@/entities/IPushNotificationSettings';

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
const storedInstallation = () =>
  sqlExecutor.oneOrNull(
    `SELECT secret_hash, token, platform, revision FROM ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} WHERE device_id = 'phone'`
  );

describeWithSeed('push installation logout', [], () => {
  it('preserves legacy registration defaults and each profile settings during token rotation', async () => {
    await registerInstallationDevice(device('A'), {}, {});
    await registerInstallationDevice(device('B'), {}, {});
    expect(
      await pushNotificationSettingsDb.getPushNotificationSettings('A', 'phone')
    ).toEqual(DEFAULT_PUSH_NOTIFICATION_SETTINGS);
    const settingsA =
      await pushNotificationSettingsDb.upsertPushNotificationSettings(
        'A',
        'phone',
        { identity_mentioned: false }
      );
    const settingsB =
      await pushNotificationSettingsDb.upsertPushNotificationSettings(
        'B',
        'phone',
        { drop_quoted: false }
      );
    await registerInstallationDevice(
      { ...device('A'), token: 'rotated-token', platform: 'android' },
      {},
      {}
    );
    expect(
      await sqlExecutor.execute(
        `SELECT profile_id, token, platform FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} WHERE device_id = 'phone' ORDER BY profile_id`
      )
    ).toEqual([
      { profile_id: 'A', token: 'rotated-token', platform: 'android' },
      { profile_id: 'B', token: 'fcm-token', platform: 'ios' }
    ]);
    expect(
      await pushNotificationSettingsDb.getPushNotificationSettings('A', 'phone')
    ).toEqual(settingsA);
    expect(
      await pushNotificationSettingsDb.getPushNotificationSettings('B', 'phone')
    ).toEqual(settingsB);
  });

  it('rejects anonymous pre-claims without changing future authenticated registration', async () => {
    await expect(revoke(1)).rejects.toThrow('native session');
    await expect(
      revokeInstallation(
        {
          device_id: 'phone',
          installation_secret: secret,
          token: 'attacker-token',
          revision: 1,
          all_profiles: true,
          sessions: []
        },
        {}
      )
    ).rejects.toThrow('native session');
    expect(
      await sqlExecutor.execute(
        `SELECT * FROM ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE}`
      )
    ).toEqual([]);
    await registerInstallationDevice(device('A'), credential, {});
    expect(await registrations()).toEqual([
      { device_id: 'phone', profile_id: 'A' }
    ]);
  });

  it('authenticates early logout with a native session, fences late registration and allows a fresh login', async () => {
    process.env.AUTH_SESSION_HASH_SECRET = 'push-logout-test-secret';
    const address = '0x' + 'a'.repeat(40);
    await sqlExecutor.execute(
      `INSERT INTO ${WALLET_AUTH_SESSIONS_TABLE} (id, address, client_type, refresh_token_hash, expires_at) VALUES (:id, :address, :client, :hash, :expires)`,
      {
        id: 'early-native',
        address,
        client: 'native',
        hash: hashSecret('native-proof'),
        expires: new Date(Date.now() + 60000)
      }
    );
    const request = {
      device_id: 'phone',
      installation_secret: secret,
      revision: 1,
      all_profiles: true,
      sessions: [
        { address: '0x' + 'A'.repeat(40), native_refresh_token: 'wrong-proof' }
      ]
    };
    await expect(revokeInstallation(request, {})).rejects.toThrow(
      'native session'
    );
    request.sessions[0].native_refresh_token = 'native-proof';
    for (const invalid of [
      { client: 'web', expires: new Date(Date.now() + 60000), revoked: null },
      {
        client: 'native',
        expires: new Date(Date.now() - 60000),
        revoked: null
      },
      {
        client: 'native',
        expires: new Date(Date.now() + 60000),
        revoked: new Date()
      }
    ]) {
      await sqlExecutor.execute(
        `UPDATE ${WALLET_AUTH_SESSIONS_TABLE} SET client_type = :client, expires_at = :expires, revoked_at = :revoked WHERE id = 'early-native'`,
        invalid
      );
      await expect(revokeInstallation(request, {})).rejects.toThrow(
        'native session'
      );
    }
    await sqlExecutor.execute(
      `UPDATE ${WALLET_AUTH_SESSIONS_TABLE} SET client_type = 'native', expires_at = :expires, revoked_at = NULL WHERE id = 'early-native'`,
      { expires: new Date(Date.now() + 60000) }
    );
    const result = await revokeInstallation(request, {});
    expect(result).toEqual({ device_id: 'phone', revision: 1 });
    expect(await storedInstallation()).toMatchObject({
      revision: 1,
      token: null,
      platform: null
    });
    expect(
      await sqlExecutor.oneOrNull(
        `SELECT revoked_at IS NOT NULL AS revoked FROM ${WALLET_AUTH_SESSIONS_TABLE} WHERE id = 'early-native'`
      )
    ).toEqual({ revoked: 1 });
    // A retry is authorized by the now-established installation secret, even
    // after the session was revoked by the first successful request.
    expect(await revokeInstallation(request, {})).toEqual({
      device_id: 'phone',
      revision: 1
    });
    await expect(
      registerInstallationDevice(device('A'), credential, {})
    ).rejects.toThrow('Stale');
    await registerInstallationDevice(
      device('A'),
      { ...credential, installation_revision: 1 },
      {}
    );
    expect(await registrations()).toEqual([
      { device_id: 'phone', profile_id: 'A' }
    ]);
  });

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
    expect(result).toEqual({ device_id: 'phone', revision: 1 });
    expect(await storedInstallation()).toMatchObject({
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
    expect(await revoke(1)).toEqual({ device_id: 'phone', revision: 1 });
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
    for (const token of ['fcm-tokeN', 'fcm-token-extra']) {
      await expect(
        registerInstallationDevice({ ...device('A'), token }, credential, {})
      ).rejects.toThrow('ambiguous');
    }
    expect(await registrations()).toHaveLength(2);
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

  it('requires retained token proof after legacy profile registrations are removed', async () => {
    await registerInstallationDevice(device('A'), {}, {});
    await sqlExecutor.execute(
      `DELETE FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} WHERE device_id = :device_id`,
      { device_id: 'phone' }
    );
    await expect(revoke(1)).rejects.toThrow('ambiguous');
    for (const token of ['fcm-tokeN', 'fcm-token-extra']) {
      await expect(
        registerInstallationDevice(
          { ...device('attacker'), token },
          credential,
          {}
        )
      ).rejects.toThrow('ambiguous');
    }
    expect(await registrations()).toEqual([]);
    const unclaimed = await sqlExecutor.oneOrNull(
      `SELECT secret_hash, revision FROM ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} WHERE device_id = :device_id`,
      { device_id: 'phone' }
    );
    expect(unclaimed).toEqual({ secret_hash: null, revision: 0 });
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
    expect(result).toEqual({ device_id: 'phone', revision: 1 });
    expect(await storedInstallation()).toMatchObject({
      revision: 1,
      token: 'fcm-token',
      platform: 'ios',
      secret_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it('mixed-session early logout cannot revoke another account without its token', async () => {
    process.env.AUTH_SESSION_HASH_SECRET = 'push-logout-test-secret';
    const owner = '0x' + '1'.repeat(40);
    const other = '0x' + '2'.repeat(40);
    for (const [id, address, token] of [
      ['owner-session', owner, 'owner-token'],
      ['other-session', other, 'other-token']
    ]) {
      await sqlExecutor.execute(
        `INSERT INTO ${WALLET_AUTH_SESSIONS_TABLE} (id, address, client_type, refresh_token_hash, expires_at) VALUES (:id, :address, 'native', :hash, :expires)`,
        {
          id,
          address,
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
          { address: other, native_refresh_token: 'guessed-token' },
          { address: owner, native_refresh_token: 'owner-token' },
          { address: other, native_refresh_token: 'owner-token' }
        ]
      },
      {}
    );
    expect(
      await sqlExecutor.execute(
        `SELECT id, revoked_at IS NOT NULL AS revoked FROM ${WALLET_AUTH_SESSIONS_TABLE} ORDER BY id`
      )
    ).toEqual([
      { id: 'other-session', revoked: 0 },
      { id: 'owner-session', revoked: 1 }
    ]);
  });

  it.each(['claimed', 'legacy', 'retained'] as const)(
    'rejects an unrelated valid native session claiming a %s victim installation',
    async (state) => {
      process.env.AUTH_SESSION_HASH_SECRET = 'push-logout-test-secret';
      const address = '0x' + '3'.repeat(40);
      const nativeToken = 'attacker-valid-native-token';
      await sqlExecutor.execute(
        `INSERT INTO ${WALLET_AUTH_SESSIONS_TABLE} (id, address, client_type, refresh_token_hash, expires_at) VALUES ('attacker-session', :address, 'native', :hash, :expires)`,
        {
          address,
          hash: hashSecret(nativeToken),
          expires: new Date(Date.now() + 600000)
        }
      );
      const victimCredential = state === 'claimed' ? credential : {};
      await registerInstallationDevice(device('A'), victimCredential, {});
      await registerInstallationDevice(device('B'), victimCredential, {});
      if (state === 'retained') {
        await sqlExecutor.execute(
          `DELETE FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} WHERE device_id = 'phone'`
        );
      }
      const readVictimInstallation = () =>
        sqlExecutor.oneOrNull(
          `SELECT secret_hash, revision, token, platform FROM ${PUSH_NOTIFICATION_DEVICE_INSTALLATIONS_TABLE} WHERE device_id = 'phone'`
        );
      const beforeInstallation = await readVictimInstallation();
      const beforeRegistrations = await registrations();
      const attack = {
        device_id: 'phone',
        installation_secret: 'b'.repeat(64),
        revision: 1,
        all_profiles: true,
        sessions: [{ address, native_refresh_token: nativeToken }]
      };
      for (const token of [undefined, 'attacker-fcm-token']) {
        await expect(
          revokeInstallation({ ...attack, token }, {})
        ).rejects.toThrow(state === 'claimed' ? 'credential' : 'ambiguous');
        expect(await readVictimInstallation()).toEqual(beforeInstallation);
        expect(await registrations()).toEqual(beforeRegistrations);
      }
      // The supplied native proof really is valid: it authorizes first logout
      // on a fresh installation, but could not claim the victim's existing one.
      const ownLogout = await revokeInstallation(
        { ...attack, device_id: 'attacker-phone' },
        {}
      );
      expect(ownLogout.revision).toBe(1);
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT revoked_at IS NOT NULL AS revoked FROM ${WALLET_AUTH_SESSIONS_TABLE} WHERE id = 'attacker-session'`
        )
      ).toEqual({ revoked: 1 });
      expect(await readVictimInstallation()).toEqual(beforeInstallation);
      expect(await registrations()).toEqual(beforeRegistrations);
    }
  );

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
    expect(result).toEqual({ device_id: 'phone', revision: 1 });
    expect(await storedInstallation()).toMatchObject({
      revision: 1,
      token: 'fcm-token',
      platform: 'ios',
      secret_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });
});
