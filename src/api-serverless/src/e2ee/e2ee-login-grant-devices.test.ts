jest.mock('@/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null)
}));

import { HDNodeWallet, Wallet } from 'ethers';
import { E2eeLoginGrantRecord, E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeDevicesService } from '@/api/e2ee/e2ee-devices.service';
import { computeDeviceGrantId } from '@/api/device-signing/device-grant-message';
import { createSiweWebAuthChallenge } from '@/api/wallet-signatures/siwe-wallet-auth';
import { E2EE_CIPHERSUITE } from '@/e2ee/e2ee.constants';
import { E2eeDb, E2eeDeviceRow } from '@/e2ee/e2ee.db';
import { e2eeRevokeDigest } from '@/e2ee/e2ee-digests';
import { E2eeApiException } from '@/e2ee/e2ee-errors';
import { buildE2eeGrantTypedData, E2eeDeviceGrant } from '@/e2ee/e2ee-grant';
import { E2eeTestKey, randomE2eeKey } from '@/tests/fixtures/e2ee.fixture';

const START = Date.UTC(2026, 9, 18, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const PROFILE = 'profile-alice';

/** The parts of E2eeDb the device service touches, kept in memory. */
class FakeE2eeDb {
  readonly devices = new Map<string, E2eeDeviceRow>();
  isGrantUnrevoked: (grantId: string) => boolean = () => true;
  readonly rosterRemovals: string[] = [];
  readonly keyPackageDeletes: string[] = [];

  async executeNativeQueriesInTransaction<T>(
    fn: (connection: unknown) => Promise<T>
  ): Promise<T> {
    return fn({});
  }
  async lockProfile(): Promise<void> {}
  async lockUnrevokedLoginGrant(grantId: string) {
    return this.isGrantUnrevoked(grantId);
  }
  async lockDevice(key: string) {
    return this.getDevice(key);
  }
  async getDevice(key: string) {
    const row = this.devices.get(key);
    return row ? { ...row } : null;
  }
  async countActiveDevices(profileId: string, atSeconds: number) {
    return Array.from(this.devices.values()).filter(
      (row) =>
        row.profile_id === profileId &&
        row.revoked_at === null &&
        row.expires_at_seconds > atSeconds
    ).length;
  }
  async insertDevice(row: E2eeDeviceRow) {
    this.devices.set(row.device_key, { ...row });
  }
  async renewDevice(fields: Partial<E2eeDeviceRow> & { device_key: string }) {
    const row = this.devices.get(fields.device_key)!;
    this.devices.set(fields.device_key, { ...row, ...fields });
  }
  async getProfilesSharingRosters(): Promise<string[]> {
    return [];
  }
  async getUnrevokedDeviceOfLoginGrant(grantId: string) {
    return (
      Array.from(this.devices.values()).find(
        (row) =>
          row.grant_id === grantId &&
          row.grant_message !== null &&
          row.revoked_at === null
      ) ?? null
    );
  }
  async markDeviceRevokedByGrant(input: {
    deviceKey: string;
    revokedAtMs: number;
  }) {
    const row = this.devices.get(input.deviceKey)!;
    this.devices.set(input.deviceKey, {
      ...row,
      revoked_at: input.revokedAtMs
    });
  }
  async markDeviceRevoked(input: {
    deviceKey: string;
    revokedAtMs: number;
    revokerDeviceKey: string;
    signedAtSeconds: number;
    signature: string;
  }) {
    const row = this.devices.get(input.deviceKey)!;
    if (row.revocation_signature !== null) return;
    this.devices.set(input.deviceKey, {
      ...row,
      revoked_at: row.revoked_at ?? input.revokedAtMs,
      revoker_device_key: input.revokerDeviceKey,
      revocation_signed_at_seconds: input.signedAtSeconds,
      revocation_signature: input.signature
    });
  }
  async removeDeviceFromAllRosters(key: string) {
    this.rosterRemovals.push(key);
  }
  async deleteKeyPackagesOfDevice(key: string) {
    this.keyPackageDeletes.push(key);
  }
  async deleteWelcomeDeliveriesOfDevice(): Promise<void> {}
}

describe('E2EE devices from combined sign-in grants (NC8)', () => {
  let now: number;
  let db: FakeE2eeDb;
  let grants: Map<string, E2eeLoginGrantRecord & { revoked_at: number | null }>;
  let walletProfiles: Map<string, string>;
  let revokedEvents: unknown[];
  let service: E2eeDevicesService;
  let alice: HDNodeWallet;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    now = START;
    db = new FakeE2eeDb();
    grants = new Map();
    walletProfiles = new Map();
    revokedEvents = [];
    alice = Wallet.createRandom();
    walletProfiles.set(alice.address.toLowerCase(), PROFILE);
    db.isGrantUnrevoked = (id) => grants.get(id)?.revoked_at === null;
    const deps: E2eeServiceDeps = {
      db: db as unknown as E2eeDb,
      events: {
        deviceAdded: async () => undefined,
        deviceRevoked: async (...args: unknown[]) => {
          revokedEvents.push(args);
        }
      } as unknown as E2eeServiceDeps['events'],
      contractWalletVerifier: {
        hasCode: async () => false,
        isValidSignature: async () => false
      },
      resolveWalletProfileId: async (wallet) =>
        walletProfiles.get(wallet) ?? null,
      now: () => now,
      random: () => 1,
      randomHex: () => '0x00',
      attachmentsEnabled: () => true,
      // Registration and revocation never consult DM admission.
      admission: {
        evaluate: async () => {
          throw new Error('admission is not used by device registration');
        }
      },
      loginGrants: {
        findGrant: async (id) => grants.get(id) ?? null,
        revokeGrant: async (id, revokedAtMs) => {
          const grant = grants.get(id);
          if (grant && grant.revoked_at === null) {
            grants.set(id, { ...grant, revoked_at: revokedAtMs });
          }
        }
      }
    };
    service = new E2eeDevicesService(deps);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function storeLoginGrant({
    signer = alice,
    mlsKey = randomE2eeKey(),
    ciphersuite = E2EE_CIPHERSUITE,
    combined = true,
    issuedAt = new Date(now)
  }: {
    signer?: HDNodeWallet;
    mlsKey?: E2eeTestKey;
    ciphersuite?: number;
    combined?: boolean;
    issuedAt?: Date;
  } = {}) {
    const challenge = createSiweWebAuthChallenge({
      address: signer.address,
      clientOrigin: 'https://staging.6529.io',
      chainId: 1,
      issuedAt,
      deviceGrant: {
        deviceKey: randomE2eeKey().publicKey,
        scopes: ['post', 'edit', 'delete', 'react'],
        mlsDevice: combined
          ? { deviceKey: mlsKey.publicKey, ciphersuite }
          : null
      }
    });
    const id = computeDeviceGrantId(challenge.message);
    grants.set(id, {
      id,
      wallet: signer.address.toLowerCase(),
      message: challenge.message,
      wallet_signature: await signer.signMessage(challenge.message),
      revoked_at: null
    });
    return { id, mlsKey, message: challenge.message };
  }

  async function expectBadGrant(promise: Promise<unknown>, reason: string) {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(E2eeApiException);
    expect((caught as E2eeApiException).code).toBe('E2EE_BAD_GRANT');
    expect((caught as E2eeApiException).message).toContain(reason);
  }

  const register = (grantId: string, profileId = PROFILE) =>
    service.registerLoginGrantDevice(profileId, {
      grant_id: grantId,
      platform: 'web' as never,
      label: 'Chrome on macOS'
    });

  it('registers the MLS key of a stored combined grant without a new signature', async () => {
    const { id, mlsKey, message } = await storeLoginGrant();

    const device = await register(id);

    expect(device).toMatchObject({
      device_key: mlsKey.publicKey,
      profile_id: PROFILE,
      grant: {
        wallet: alice.address.toLowerCase(),
        device_key: mlsKey.publicKey,
        ciphersuite: E2EE_CIPHERSUITE,
        issued_at: START / 1000,
        expires_at: START / 1000 + 180 * 86400,
        origin: 'staging.6529.io'
      },
      grant_id: id,
      wallet_signature: grants.get(id)!.wallet_signature.toLowerCase(),
      verified_via: 'eoa',
      label: 'Chrome on macOS',
      grant_message: message
    });
  });

  it('marks a contract-wallet login grant as verified through EIP-1271', async () => {
    const { id } = await storeLoginGrant();
    // The login verified this signature on chain; it does not recover to the wallet.
    grants.set(id, { ...grants.get(id)!, wallet_signature: '0x' });

    expect((await register(id)).verified_via).toBe('eip1271');
  });

  it.each([
    ['an unknown grant', 'login_grant_not_found'],
    ['a malformed grant id', 'login_grant_not_found']
  ])('rejects %s', async (name, reason) => {
    await expectBadGrant(
      register(name === 'an unknown grant' ? `0x${'1'.repeat(64)}` : 'nope'),
      reason
    );
  });

  it('rejects a revoked sign-in grant', async () => {
    const { id } = await storeLoginGrant();
    grants.set(id, { ...grants.get(id)!, revoked_at: now });
    await expectBadGrant(register(id), 'login_grant_revoked');
  });

  it('rejects a grant revoked while the registration was in flight', async () => {
    const { id } = await storeLoginGrant();
    // Verified outside the transaction, revoked before the row lock.
    db.isGrantUnrevoked = () => false;
    await expectBadGrant(register(id), 'login_grant_revoked');
    expect(db.devices.size).toBe(0);
  });

  it('completes a failed sign-in grant revocation when the device is revoked again', async () => {
    const { id, mlsKey } = await storeLoginGrant();
    await register(id);
    const row = db.devices.get(mlsKey.publicKey)!;
    db.devices.set(mlsKey.publicKey, { ...row, revoked_at: now });
    const revokedAt = Math.floor(now / 1000);

    await service.revokeDevice(PROFILE, mlsKey.publicKey, {
      revoker_device_key: mlsKey.publicKey,
      revoked_at: revokedAt,
      signature: mlsKey.sign(
        e2eeRevokeDigest({
          targetDeviceKey: mlsKey.publicKey,
          revokerDeviceKey: mlsKey.publicKey,
          revokedAtSeconds: revokedAt
        })
      )
    });

    expect(grants.get(id)!.revoked_at).toBe(now);
  });

  it('rejects a signing-only sign-in grant (the separate prompt stays the path)', async () => {
    const { id } = await storeLoginGrant({ combined: false });
    await expectBadGrant(register(id), 'login_grant_without_e2ee');
  });

  it('rejects a stored message that does not hash to the grant id', async () => {
    const { id, message } = await storeLoginGrant();
    grants.set(id, {
      ...grants.get(id)!,
      message: message.replace('Nonce: ', 'Nonce: a')
    });
    await expectBadGrant(register(id), 'login_grant_without_e2ee');
  });

  it('rejects a grant for another ciphersuite', async () => {
    const { id } = await storeLoginGrant({ ciphersuite: E2EE_CIPHERSUITE + 1 });
    await expectBadGrant(register(id), 'ciphersuite');
  });

  it('rejects an expired grant', async () => {
    const { id } = await storeLoginGrant();
    now += 181 * DAY_MS;
    await expectBadGrant(register(id), 'expired');
  });

  it('rejects a grant of a wallet outside the caller profile', async () => {
    const { id } = await storeLoginGrant();
    await expectBadGrant(register(id, 'profile-bob'), 'wallet_not_in_profile');
  });

  it('renews an EIP-712 device to the sign-in grant and back', async () => {
    const mlsKey = randomE2eeKey();
    const grant: E2eeDeviceGrant = {
      wallet: alice.address.toLowerCase(),
      device_key: mlsKey.publicKey,
      ciphersuite: E2EE_CIPHERSUITE,
      issued_at: START / 1000,
      expires_at: START / 1000 + 180 * 86400,
      origin: 'staging.6529.io'
    };
    const typedData = buildE2eeGrantTypedData(grant);
    const registerEip712 = async () =>
      service.registerDevice(PROFILE, {
        grant,
        wallet_signature: await alice.signTypedData(
          typedData.domain,
          typedData.types,
          typedData.message
        ),
        platform: 'web' as never
      });
    expect((await registerEip712()).grant_message).toBeNull();

    now += DAY_MS;
    const { id, message } = await storeLoginGrant({ mlsKey });
    const renewed = await register(id);
    expect(renewed.grant_message).toBe(message);
    expect(renewed.grant_id).toBe(id);
    expect(renewed.grant.expires_at).toBe(grant.expires_at + 86400);

    expect((await registerEip712()).grant_message).toBeNull();
    expect(db.devices.size).toBe(1);
  });

  it('revoking the device also revokes its sign-in grant (signing stops too)', async () => {
    const { id, mlsKey } = await storeLoginGrant();
    await register(id);
    const revokedAt = Math.floor(now / 1000);

    const revoked = await service.revokeDevice(PROFILE, mlsKey.publicKey, {
      revoker_device_key: mlsKey.publicKey,
      revoked_at: revokedAt,
      signature: mlsKey.sign(
        e2eeRevokeDigest({
          targetDeviceKey: mlsKey.publicKey,
          revokerDeviceKey: mlsKey.publicKey,
          revokedAtSeconds: revokedAt
        })
      )
    });

    expect(revoked.revoked_at).toBe(now);
    expect(grants.get(id)!.revoked_at).toBe(now);
  });

  it('revoking an EIP-712 device leaves sign-in grants alone', async () => {
    const { id } = await storeLoginGrant({ combined: false });
    const mlsKey = randomE2eeKey();
    const grant: E2eeDeviceGrant = {
      wallet: alice.address.toLowerCase(),
      device_key: mlsKey.publicKey,
      ciphersuite: E2EE_CIPHERSUITE,
      issued_at: START / 1000,
      expires_at: START / 1000 + 180 * 86400,
      origin: 'staging.6529.io'
    };
    const typedData = buildE2eeGrantTypedData(grant);
    await service.registerDevice(PROFILE, {
      grant,
      wallet_signature: await alice.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message
      ),
      platform: 'web' as never
    });
    const revokedAt = Math.floor(now / 1000);
    await service.revokeDevice(PROFILE, mlsKey.publicKey, {
      revoker_device_key: mlsKey.publicKey,
      revoked_at: revokedAt,
      signature: mlsKey.sign(
        e2eeRevokeDigest({
          targetDeviceKey: mlsKey.publicKey,
          revokerDeviceKey: mlsKey.publicKey,
          revokedAtSeconds: revokedAt
        })
      )
    });
    expect(grants.get(id)!.revoked_at).toBeNull();
  });

  it('revoking the sign-in grant revokes the device it enrolled, once', async () => {
    const { id, mlsKey } = await storeLoginGrant();
    await register(id);
    now += 1000;

    await service.revokeDeviceOfLoginGrant(id);
    await service.revokeDeviceOfLoginGrant(id);

    const device = await service.getDevice(mlsKey.publicKey);
    expect(device.revoked_at).toBe(now);
    // 6529.io stops delivery; the record carries no device signature.
    expect(device.revocation).toBeNull();
    expect(db.rosterRemovals).toEqual([mlsKey.publicKey]);
    expect(db.keyPackageDeletes).toEqual([mlsKey.publicKey]);
    expect(revokedEvents).toEqual([
      [[PROFILE], { profile_id: PROFILE, device_key: mlsKey.publicKey }]
    ]);
    // And the revoked grant can no longer enroll it again.
    grants.set(id, { ...grants.get(id)!, revoked_at: now });
    await expectBadGrant(register(id), 'login_grant_revoked');
  });

  it('stores a signed revocation for a device its sign-in grant revoked', async () => {
    const { id, mlsKey } = await storeLoginGrant();
    await register(id);
    now += 1000;
    await service.revokeDeviceOfLoginGrant(id);
    const revokedByGrantAt = now;
    now += 1000;
    const revokedAt = Math.floor(now / 1000);
    const signature = mlsKey.sign(
      e2eeRevokeDigest({
        targetDeviceKey: mlsKey.publicKey,
        revokerDeviceKey: mlsKey.publicKey,
        revokedAtSeconds: revokedAt
      })
    );
    const request = {
      revoker_device_key: mlsKey.publicKey,
      revoked_at: revokedAt,
      signature
    };

    const signed = await service.revokeDevice(
      PROFILE,
      mlsKey.publicKey,
      request
    );

    // Still revoked since the grant revocation; now verifiable by members.
    expect(signed.revoked_at).toBe(revokedByGrantAt);
    expect(signed.revocation).toEqual({
      revoker_device_key: mlsKey.publicKey,
      revoked_at: revokedAt,
      signature
    });
    expect(db.rosterRemovals).toEqual([mlsKey.publicKey]);
    // A second signed revocation never replaces the stored one.
    now += 1000;
    const again = await service.revokeDevice(PROFILE, mlsKey.publicKey, {
      ...request,
      revoked_at: revokedAt + 1
    });
    expect(again.revocation?.revoked_at).toBe(revokedAt);
  });

  it('ignores sign-in grants that enrolled no device', async () => {
    const { id } = await storeLoginGrant();
    await service.revokeDeviceOfLoginGrant(id);
    expect(revokedEvents).toEqual([]);
  });
});
