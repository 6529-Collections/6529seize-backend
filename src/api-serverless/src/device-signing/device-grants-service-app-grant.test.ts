import { HDNodeWallet, Wallet } from 'ethers';
import { mock } from 'ts-jest-mocker';
import { ApiRegisterDeviceGrantRequest } from '@/api/generated/models/ApiRegisterDeviceGrantRequest';
import { AuthenticationContext } from '@/auth-context';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { IdentitiesDb } from '@/identities/identities.db';
import {
  APP_DEVICE_GRANT_DOMAIN,
  APP_DEVICE_GRANT_TYPES,
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

  it('grants no encrypted-messages key to a wallet without a profile', async () => {
    jest.mocked(identities.getProfileIdByWallet).mockResolvedValue(null);
    await expect(
      service.registerAppGrant(
        await signedRequest(),
        caller({ authenticatedProfileId: null })
      )
    ).rejects.toThrow('encrypted messages need a profile');
  });
});
