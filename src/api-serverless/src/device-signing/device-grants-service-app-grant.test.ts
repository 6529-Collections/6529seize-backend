import { HDNodeWallet, Wallet } from 'ethers';
import { mock } from 'ts-jest-mocker';
import { ApiRegisterDeviceGrantRequest } from '@/api/generated/models/ApiRegisterDeviceGrantRequest';
import { AuthenticationContext } from '@/auth-context';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { IdentitiesDb } from '@/identities/identities.db';
import {
  APP_DEVICE_GRANT_DOMAIN,
  APP_DEVICE_GRANT_DOMAIN_V2,
  APP_DEVICE_GRANT_TYPES,
  APP_DEVICE_GRANT_TYPES_V2,
  AppDeviceGrant,
  buildAppDeviceGrantMessage,
  computeAppDeviceGrantId,
  parseAppDeviceGrantMessage
} from './app-device-grant';
import { DeviceGrantsService } from './device-grants.service';
import { DeviceSigningDb } from './device-signing.db';

const NOW_SECONDS = 1_792_324_800;
const NOW = NOW_SECONDS * 1000;
const SIGNING_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const MLS_KEY =
  '0x3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';

describe('DeviceGrantsService.registerAppGrant', () => {
  let db: DeviceSigningDb;
  let identities: IdentitiesDb;
  let e2eeEnabled: boolean;
  let contractWallet: {
    hasCode: jest.Mock;
    isValidSignature: jest.Mock;
  };
  let service: DeviceGrantsService;
  let wallet: HDNodeWallet;

  beforeEach(() => {
    db = mock(DeviceSigningDb);
    identities = mock(IdentitiesDb);
    e2eeEnabled = true;
    contractWallet = {
      hasCode: jest.fn().mockResolvedValue(false),
      isValidSignature: jest.fn().mockResolvedValue(false)
    };
    service = new DeviceGrantsService(db, identities, () => NOW, {
      contractWalletVerifier: contractWallet,
      e2eeEnabled: () => e2eeEnabled
    });
    wallet = Wallet.createRandom();
    jest.mocked(db.insertGrant).mockResolvedValue(true);
    jest.mocked(identities.getProfileIdByWallet).mockResolvedValue('profile-1');
  });

  function caller(
    overrides: Partial<{
      authenticatedWallet: string;
      authenticatedProfileId: string | null;
      roleProfileId: string | null;
    }> = {}
  ) {
    return {
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: wallet.address.toLowerCase(),
        authenticatedProfileId: 'profile-1',
        roleProfileId: null,
        activeProxyActions: [],
        ...overrides
      })
    };
  }

  function grantFields(
    overrides: Partial<AppDeviceGrant> = {}
  ): AppDeviceGrant {
    return {
      wallet: wallet.address.toLowerCase(),
      device_key: SIGNING_KEY,
      scopes: ['post', 'edit', 'delete', 'react'],
      mls_device_key: MLS_KEY,
      ciphersuite: 0x004f,
      issued_at: NOW_SECONDS,
      expires_at: NOW_SECONDS + 180 * 86400,
      origin: '6529.io',
      ...overrides
    };
  }

  async function signedRequest(
    overrides: Partial<AppDeviceGrant> = {},
    signer: HDNodeWallet = wallet
  ): Promise<ApiRegisterDeviceGrantRequest> {
    const grant = grantFields(overrides);
    const signature = await signer.signTypedData(
      APP_DEVICE_GRANT_DOMAIN,
      APP_DEVICE_GRANT_TYPES,
      buildAppDeviceGrantMessage(grant)
    );
    return {
      grant: { ...grant, scopes: [...grant.scopes] },
      wallet_signature: signature,
      device_label: ' 6529 Mobile <iPhone> '
    };
  }

  it('stores a combined grant keyed by its EIP-712 digest', async () => {
    const request = await signedRequest();

    const stored = await service.registerAppGrant(request, caller());

    const message = buildAppDeviceGrantMessage(grantFields());
    const id = computeAppDeviceGrantId(message);
    const entity = jest.mocked(db.insertGrant).mock
      .calls[0][0] as DeviceGrantEntity;
    expect(entity).toMatchObject({
      id,
      wallet: wallet.address.toLowerCase(),
      key_type: 'ed25519',
      device_key: SIGNING_KEY,
      scopes: 'post,edit,delete,react',
      device_label: '6529 Mobile iPhone',
      domain: '6529.io',
      wallet_signature: request.wallet_signature.toLowerCase(),
      chain_id: 1,
      issued_at: NOW,
      expires_at: (NOW_SECONDS + 180 * 86400) * 1000,
      created_at: NOW,
      revoked_at: null
    });
    // The stored message is the signed typed data, so anyone can re-verify.
    expect(parseAppDeviceGrantMessage(entity.message)).toEqual({
      grant: grantFields(),
      message
    });
    expect(stored).toMatchObject({ id, domain: '6529.io' });
    expect(stored).not.toHaveProperty('message');
  });

  it('stores a signing-only grant for a wallet without a profile', async () => {
    jest.mocked(identities.getProfileIdByWallet).mockResolvedValue(null);
    const request = await signedRequest({
      mls_device_key: null,
      ciphersuite: null,
      origin: '6529 Desktop'
    });

    await service.registerAppGrant(
      request,
      caller({ authenticatedProfileId: null })
    );

    expect(db.insertGrant).toHaveBeenCalledTimes(1);
  });

  it('returns the stored grant when it is registered again', async () => {
    jest.mocked(db.insertGrant).mockResolvedValue(false);
    jest.mocked(db.findGrantById).mockImplementation(async (id) => ({
      ...(jest.mocked(db.insertGrant).mock.calls[0][0] as DeviceGrantEntity),
      id,
      revoked_at: 5
    }));

    const stored = await service.registerAppGrant(
      await signedRequest(),
      caller()
    );

    expect(stored.revoked_at).toBe(5);
  });

  it('accepts a contract wallet through EIP-1271', async () => {
    contractWallet.hasCode.mockResolvedValue(true);
    contractWallet.isValidSignature.mockResolvedValue(true);
    const request = {
      ...(await signedRequest()),
      wallet_signature: '0xabcd'
    };

    await service.registerAppGrant(request, caller());

    expect(contractWallet.isValidSignature).toHaveBeenCalledWith(
      wallet.address.toLowerCase(),
      computeAppDeviceGrantId(buildAppDeviceGrantMessage(grantFields())),
      '0xabcd'
    );
  });

  it('rejects a grant signed by another wallet', async () => {
    const request = await signedRequest({}, Wallet.createRandom());
    await expect(service.registerAppGrant(request, caller())).rejects.toThrow(
      'Invalid device grant: signer_mismatch'
    );
    expect(db.insertGrant).not.toHaveBeenCalled();
  });

  it('only accepts the signed-in wallet as the grant wallet', async () => {
    const request = await signedRequest();
    await expect(
      service.registerAppGrant(
        request,
        caller({ authenticatedWallet: `0x${'2'.repeat(40)}` })
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('is not available to proxies', async () => {
    await expect(
      service.registerAppGrant(
        await signedRequest(),
        caller({ roleProfileId: 'principal' })
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects stale grants', async () => {
    const request = await signedRequest({
      issued_at: NOW_SECONDS - 2 * 86400,
      expires_at: NOW_SECONDS + 170 * 86400
    });
    await expect(service.registerAppGrant(request, caller())).rejects.toThrow(
      'issued_too_long_ago'
    );
  });

  it('grants no encrypted-messages key while encrypted messages are off', async () => {
    e2eeEnabled = false;
    await expect(
      service.registerAppGrant(await signedRequest(), caller())
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.insertGrant).not.toHaveBeenCalled();
  });

  describe('after the transition window closes (D172)', () => {
    // The window started 2026-11-10 and lasted 14 days; it is now December.
    const LATER = Date.UTC(2026, 11, 1);
    const times = {
      issued_at: LATER / 1000,
      expires_at: LATER / 1000 + 180 * 86400
    };
    let previous: string | undefined;

    beforeEach(() => {
      previous = process.env.E2EE_SUITE_TRANSITION_START;
      process.env.E2EE_SUITE_TRANSITION_START = '2026-11-10T00:00:00Z';
      service = new DeviceGrantsService(db, identities, () => LATER, {
        contractWalletVerifier: contractWallet,
        e2eeEnabled: () => e2eeEnabled
      });
    });

    afterEach(() => {
      if (previous === undefined) {
        delete process.env.E2EE_SUITE_TRANSITION_START;
      } else {
        process.env.E2EE_SUITE_TRANSITION_START = previous;
      }
    });

    async function signedV2(suites: number[]) {
      const grant = grantFields({
        ...times,
        version: 2,
        ciphersuite: suites[0],
        ciphersuites: suites
      });
      return {
        grant: { ...grant, scopes: [...grant.scopes] },
        wallet_signature: await wallet.signTypedData(
          APP_DEVICE_GRANT_DOMAIN_V2,
          APP_DEVICE_GRANT_TYPES_V2,
          buildAppDeviceGrantMessage(grant)
        ),
        device_label: '6529 Mobile'
      } as ApiRegisterDeviceGrantRequest;
    }

    it('refuses a v1 or 0x004F-only encryption grant when it is created', async () => {
      await expect(
        service.registerAppGrant(await signedRequest(times), caller())
      ).rejects.toThrow('names no ciphersuite the server accepts now');
      await expect(
        service.registerAppGrant(await signedV2([0x004f]), caller())
      ).rejects.toThrow('names no ciphersuite the server accepts now');
      expect(db.insertGrant).not.toHaveBeenCalled();
    });

    it('still stores a 0x004E encryption grant and a signing-only grant', async () => {
      await service.registerAppGrant(
        await signedV2([0x004e, 0x004f]),
        caller()
      );
      await service.registerAppGrant(
        await signedRequest({
          ...times,
          mls_device_key: null,
          ciphersuite: null
        }),
        caller()
      );
      expect(db.insertGrant).toHaveBeenCalledTimes(2);
    });
  });

  it('grants no encrypted-messages key to a wallet without a profile', async () => {
    jest.mocked(identities.getProfileIdByWallet).mockResolvedValue(null);
    await expect(
      service.registerAppGrant(
        await signedRequest(),
        caller({ authenticatedProfileId: null })
      )
    ).rejects.toThrow('encrypted messages need a profile');
  });

  describe('registration record and origin check', () => {
    const SESSION_ID = '7d0f5b5e-2c1c-4c2e-9d4b-0b3a1a2c3d4e';
    let savedPolicy: string | undefined;
    let write: jest.SpyInstance;

    beforeEach(() => {
      savedPolicy = process.env.DEVICE_GRANT_ORIGIN_POLICY;
      delete process.env.DEVICE_GRANT_ORIGIN_POLICY;
      write = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
    });

    afterEach(() => {
      write.mockRestore();
      if (savedPolicy === undefined) {
        delete process.env.DEVICE_GRANT_ORIGIN_POLICY;
      } else {
        process.env.DEVICE_GRANT_ORIGIN_POLICY = savedPolicy;
      }
    });

    function registeringCaller(origin: string | null = 'https://6529.io') {
      return {
        ...caller(),
        registration: {
          apiHost: 'api.6529.io',
          requestOrigin: origin,
          session: {
            clientType: 'native' as const,
            binding: 'structured' as const,
            sessionId: SESSION_ID
          }
        }
      };
    }

    function originLines() {
      return write.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes('6529.device_grant_origin.v1'))
        .map((line) => JSON.parse(line));
    }

    it('stores how the grant was registered', async () => {
      await service.registerAppGrant(
        await signedRequest(),
        registeringCaller()
      );

      expect(jest.mocked(db.insertGrant).mock.calls[0][0]).toMatchObject({
        domain: '6529.io',
        registered_client_type: 'native',
        registered_binding: 'structured',
        registered_request_origin: 'https://6529.io',
        registered_session_id: SESSION_ID
      });
      expect(originLines()[0]).toMatchObject({
        Route: 'device_grants',
        Verdict: 'recognized',
        Reason: 'web_origin',
        Decision: 'accepted'
      });
    });

    it('stores nulls for a caller whose token has no session claims', async () => {
      await service.registerAppGrant(await signedRequest(), caller());

      expect(jest.mocked(db.insertGrant).mock.calls[0][0]).toMatchObject({
        registered_client_type: null,
        registered_binding: null,
        registered_request_origin: null,
        registered_session_id: null
      });
    });

    it('accepts and logs an unrecognised origin by default', async () => {
      await service.registerAppGrant(
        await signedRequest({ origin: 'localhost:43123' }),
        registeringCaller('http://localhost:43123')
      );

      expect(db.insertGrant).toHaveBeenCalledTimes(1);
      expect(originLines()[0]).toMatchObject({
        Verdict: 'unrecognized',
        Reason: 'loopback',
        Policy: 'log',
        Decision: 'accepted'
      });
    });

    it('refuses an unrecognised origin when enforcing', async () => {
      process.env.DEVICE_GRANT_ORIGIN_POLICY = 'enforce';

      await expect(
        service.registerAppGrant(
          await signedRequest({ origin: 'staging.6529.io' }),
          registeringCaller()
        )
      ).rejects.toThrow('Invalid device grant: unrecognized origin');
      expect(db.insertGrant).not.toHaveBeenCalled();
    });

    it('still stores the origins honest clients sign when enforcing', async () => {
      process.env.DEVICE_GRANT_ORIGIN_POLICY = 'enforce';

      await service.registerAppGrant(
        await signedRequest(),
        registeringCaller()
      );
      await service.registerAppGrant(
        await signedRequest({
          origin: '6529 Desktop',
          issued_at: NOW_SECONDS - 60
        }),
        registeringCaller(null)
      );

      expect(db.insertGrant).toHaveBeenCalledTimes(2);
    });

    it('checks the origin only after the signature verified', async () => {
      process.env.DEVICE_GRANT_ORIGIN_POLICY = 'enforce';

      await expect(
        service.registerAppGrant(
          await signedRequest(
            { origin: 'unlisted.example' },
            Wallet.createRandom()
          ),
          registeringCaller()
        )
      ).rejects.toThrow('Invalid device grant: signer_mismatch');
      expect(originLines()).toHaveLength(0);
    });
  });
});
