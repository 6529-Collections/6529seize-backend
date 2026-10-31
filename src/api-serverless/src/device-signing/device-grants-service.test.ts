import { ethers } from 'ethers';
import { mock } from 'ts-jest-mocker';
import { AuthenticationContext } from '@/auth-context';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { ForbiddenException, NotFoundException } from '@/exceptions';
import { IdentitiesDb } from '@/identities/identities.db';
import { DeviceGrantsService } from './device-grants.service';
import { DeviceSigningDb } from './device-signing.db';

const NOW = 1_790_000_000_000;
const WALLET = '0x1111111111111111111111111111111111111111';
const DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const MESSAGE = 'exact signed SIWE message';
const GRANT_ID =
  '0x8f0d8a4d2f4bd2a3f95ef1b3a0c37d2b1b0bd1f9a60dbe26b5e4e5af8b7c2d11';

function aGrant(overrides: Partial<DeviceGrantEntity> = {}): DeviceGrantEntity {
  return {
    id: GRANT_ID,
    wallet: WALLET,
    key_type: 'ed25519',
    device_key: DEVICE_KEY,
    scopes: 'post,edit,delete,react',
    device_label: 'Chrome on macOS',
    domain: '6529.io',
    message: MESSAGE,
    wallet_signature: '0xsig',
    chain_id: 1,
    issued_at: NOW - 10,
    expires_at: NOW + 1000,
    created_at: NOW - 5,
    revoked_at: null,
    last_used_at: null,
    ...overrides
  };
}

function callerContext(
  overrides: Partial<{
    authenticatedProfileId: string | null;
    roleProfileId: string | null;
  }> = {}
) {
  return {
    authenticationContext: new AuthenticationContext({
      authenticatedWallet: WALLET,
      authenticatedProfileId: 'profile-1',
      roleProfileId: null,
      activeProxyActions: [],
      ...overrides
    })
  };
}

describe('DeviceGrantsService', () => {
  let db: DeviceSigningDb;
  let identities: IdentitiesDb;
  let service: DeviceGrantsService;

  beforeEach(() => {
    db = mock(DeviceSigningDb);
    identities = mock(IdentitiesDb);
    service = new DeviceGrantsService(db, identities, () => NOW);
    jest.mocked(db.insertGrant).mockResolvedValue(true);
    jest.mocked(db.revokeGrant).mockResolvedValue(undefined);
    jest.mocked(identities.getProfileIdByWallet).mockResolvedValue('profile-1');
  });

  describe('storeLoginGrant', () => {
    const verifiedGrant = {
      terms: {
        keyType: 'ed25519' as const,
        deviceKey: DEVICE_KEY,
        scopes: ['post', 'react'] as const,
        expiresAtSeconds: 1807876800
      },
      message: MESSAGE,
      walletSignature: '0xsig',
      wallet: WALLET.toUpperCase().replace('0X', '0x'),
      domain: 'staging.6529.io',
      chainId: 1,
      issuedAt: new Date('2026-10-18T12:00:00.000Z'),
      deviceLabel: '  Chrome   on <macOS>  '
    };

    it('stores the grant keyed by the EIP-191 hash of the signed message', async () => {
      const grant = await service.storeLoginGrant(verifiedGrant, {});
      const expectedId = ethers.hashMessage(MESSAGE).toLowerCase();
      expect(db.insertGrant).toHaveBeenCalledWith(
        {
          id: expectedId,
          wallet: WALLET,
          key_type: 'ed25519',
          device_key: DEVICE_KEY,
          scopes: 'post,react',
          device_label: 'Chrome on macOS',
          domain: 'staging.6529.io',
          message: MESSAGE,
          wallet_signature: '0xsig',
          chain_id: 1,
          issued_at: Date.parse('2026-10-18T12:00:00.000Z'),
          expires_at: 1807876800000,
          created_at: NOW,
          revoked_at: null,
          last_used_at: null
        },
        {}
      );
      expect(grant).toEqual({
        id: expectedId,
        wallet: WALLET,
        key_type: 'ed25519',
        device_key: DEVICE_KEY,
        scopes: ['post', 'react'],
        device_label: 'Chrome on macOS',
        domain: 'staging.6529.io',
        issued_at: Date.parse('2026-10-18T12:00:00.000Z'),
        expires_at: 1807876800000,
        created_at: NOW,
        revoked_at: null,
        last_used_at: null
      });
    });

    it('returns the stored grant when it already exists', async () => {
      jest.mocked(db.insertGrant).mockResolvedValue(false);
      jest
        .mocked(db.findGrantById)
        .mockResolvedValue(aGrant({ created_at: 1, last_used_at: 2 }));

      const grant = await service.storeLoginGrant(verifiedGrant, {});

      expect(grant).toMatchObject({ created_at: 1, last_used_at: 2 });
    });

    it('propagates storage failures to the caller', async () => {
      jest.mocked(db.insertGrant).mockRejectedValue(new Error('db down'));
      await expect(service.storeLoginGrant(verifiedGrant, {})).rejects.toThrow(
        'db down'
      );
    });
  });

  describe('listCallerGrants', () => {
    it('lists the grants of every wallet of the profile', async () => {
      jest
        .mocked(db.findGrantsOfProfile)
        .mockResolvedValue([aGrant({ revoked_at: NOW })]);

      const grants = await service.listCallerGrants(callerContext());

      expect(db.findGrantsOfProfile).toHaveBeenCalledWith(
        'profile-1',
        expect.anything()
      );
      expect(grants).toEqual([
        expect.objectContaining({ id: GRANT_ID, revoked_at: NOW })
      ]);
      expect(grants[0]).not.toHaveProperty('message');
    });

    it('falls back to the authenticated wallet without a profile', async () => {
      jest.mocked(db.findGrantsOfWallet).mockResolvedValue([]);

      await service.listCallerGrants(
        callerContext({ authenticatedProfileId: null })
      );

      expect(db.findGrantsOfWallet).toHaveBeenCalledWith(
        WALLET,
        expect.anything()
      );
      expect(db.findGrantsOfProfile).not.toHaveBeenCalled();
    });

    it('is not available to proxies', async () => {
      await expect(
        service.listCallerGrants(
          callerContext({ roleProfileId: 'principal-profile' })
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('revokeCallerGrant', () => {
    it('revokes a grant of the caller profile and returns it', async () => {
      jest
        .mocked(db.findGrantById)
        .mockResolvedValueOnce(aGrant())
        .mockResolvedValueOnce(aGrant({ revoked_at: NOW }));

      const grant = await service.revokeCallerGrant(GRANT_ID, callerContext());

      expect(db.revokeGrant).toHaveBeenCalledWith(
        GRANT_ID,
        NOW,
        expect.anything()
      );
      expect(grant.revoked_at).toBe(NOW);
    });

    it('is idempotent for an already revoked grant', async () => {
      jest
        .mocked(db.findGrantById)
        .mockResolvedValue(aGrant({ revoked_at: 123 }));

      const grant = await service.revokeCallerGrant(GRANT_ID, callerContext());

      expect(db.revokeGrant).not.toHaveBeenCalled();
      expect(grant.revoked_at).toBe(123);
    });

    it('hides grants of other profiles', async () => {
      jest.mocked(db.findGrantById).mockResolvedValue(aGrant());
      jest.mocked(identities.getProfileIdByWallet).mockResolvedValue('other');

      await expect(
        service.revokeCallerGrant(GRANT_ID, callerContext())
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(db.revokeGrant).not.toHaveBeenCalled();
    });

    it('compares wallets directly for profileless callers', async () => {
      jest
        .mocked(db.findGrantById)
        .mockResolvedValue(aGrant({ wallet: `0x${'2'.repeat(40)}` }));

      await expect(
        service.revokeCallerGrant(
          GRANT_ID,
          callerContext({ authenticatedProfileId: null })
        )
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(identities.getProfileIdByWallet).not.toHaveBeenCalled();
    });

    it.each(['not-a-grant-id', GRANT_ID.toUpperCase()])(
      'returns 404 for malformed id %s without a lookup',
      async (grantId) => {
        await expect(
          service.revokeCallerGrant(grantId, callerContext())
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(db.findGrantById).not.toHaveBeenCalled();
      }
    );

    it('returns 404 for unknown grants', async () => {
      jest.mocked(db.findGrantById).mockResolvedValue(null);
      await expect(
        service.revokeCallerGrant(GRANT_ID, callerContext())
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is not available to proxies', async () => {
      await expect(
        service.revokeCallerGrant(
          GRANT_ID,
          callerContext({ roleProfileId: 'principal-profile' })
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.findGrantById).not.toHaveBeenCalled();
    });
  });
});
