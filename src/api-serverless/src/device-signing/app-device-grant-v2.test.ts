import { TypedDataEncoder, Wallet } from 'ethers';
import {
  APP_DEVICE_GRANT_DOMAIN_V2,
  APP_DEVICE_GRANT_TYPES_V2,
  AppDeviceGrant,
  buildAppDeviceGrantMessage,
  computeAppDeviceGrantId,
  findAppDeviceGrantProblem,
  parseAppDeviceGrantMessage,
  serializeAppDeviceGrantMessage,
  verifyAppDeviceGrant
} from './app-device-grant';

// App grant v2 (D172) shared vectors: the v1 vectors' wallet, keys and times
// with `uint16[] ciphersuites` (domain version "2"). Clients pin the same.
// Hardhat's first test account, never a real wallet.
const PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const SIGNING_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const MLS_KEY =
  '0x3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';
const ISSUED_AT = 1792324800;
const EXPIRES_AT = 1807876800;
const NOW_SECONDS = ISSUED_AT + 60;
const SIGNING_GRANT_ID_V2 =
  '0x9c049140e722cb25940749c8b9ba5167b4fa79c56d97aad08a3fa8bf9d98d29f';
const COMBINED_GRANT_ID_V2 =
  '0x512beaf4b8e41c4e3ed31526432e8c8ec44215f2157244750c8395b1bb06acb3';
const COMBINED_SIGNATURE_V2 =
  '0xd48f0e4508c1c479fd8c746c7f1db8324a11daf65069ca1e71b849f6951770837abb735d30bffe543153fff9591be95ab2a8731e3b580be8dd113a5d51211e811c';

function signingGrant(overrides: Partial<AppDeviceGrant> = {}): AppDeviceGrant {
  return {
    version: 2,
    wallet: WALLET,
    device_key: SIGNING_KEY,
    scopes: ['post', 'edit', 'delete', 'react'],
    mls_device_key: null,
    ciphersuite: null,
    ciphersuites: [],
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    origin: '6529 Desktop',
    ...overrides
  };
}

const combinedGrant = (overrides: Partial<AppDeviceGrant> = {}) =>
  signingGrant({
    mls_device_key: MLS_KEY,
    ciphersuite: 0x004e,
    ciphersuites: [0x004e],
    ...overrides
  });

const noContractWallet = {
  hasCode: jest.fn().mockResolvedValue(false),
  isValidSignature: jest.fn().mockResolvedValue(false)
};

describe('app device grant v2 (suite set)', () => {
  it('signs `uint16[] ciphersuites` under domain version 2', () => {
    expect(APP_DEVICE_GRANT_DOMAIN_V2.version).toBe('2');
    expect(
      TypedDataEncoder.from(APP_DEVICE_GRANT_TYPES_V2).encodeType('DeviceGrant')
    ).toBe(
      'DeviceGrant(string statement,address wallet,bytes32 deviceKey,string scopes,bytes32 mlsDeviceKey,uint16[] ciphersuites,uint64 issuedAt,uint64 expiresAt,string origin)'
    );
  });

  it('matches the shared signing-only and combined v2 vectors', async () => {
    const signing = buildAppDeviceGrantMessage(signingGrant());
    expect(signing.ciphersuites).toEqual([]);
    expect(signing.mlsDeviceKey).toBe(`0x${'0'.repeat(64)}`);
    expect(computeAppDeviceGrantId(signing)).toBe(SIGNING_GRANT_ID_V2);
    const combined = buildAppDeviceGrantMessage(combinedGrant());
    expect(combined.ciphersuites).toEqual([0x004e]);
    expect(computeAppDeviceGrantId(combined)).toBe(COMBINED_GRANT_ID_V2);
    await expect(
      new Wallet(PRIVATE_KEY).signTypedData(
        APP_DEVICE_GRANT_DOMAIN_V2,
        APP_DEVICE_GRANT_TYPES_V2,
        combined
      )
    ).resolves.toBe(COMBINED_SIGNATURE_V2);
  });

  it('verifies a v2 grant and stores it as JSON with `ciphersuites`', async () => {
    const grant = combinedGrant();
    const message = buildAppDeviceGrantMessage(grant);
    const signature = await new Wallet(PRIVATE_KEY).signTypedData(
      APP_DEVICE_GRANT_DOMAIN_V2,
      APP_DEVICE_GRANT_TYPES_V2,
      message
    );
    const verified = await verifyAppDeviceGrant({
      grant,
      signature,
      contractWalletVerifier: noContractWallet
    });
    expect(verified).toMatchObject({
      ok: true,
      grantId: COMBINED_GRANT_ID_V2,
      verifiedVia: 'eoa'
    });
    const text = serializeAppDeviceGrantMessage(message);
    expect(JSON.parse(text)).toHaveProperty('ciphersuites', [0x004e]);
    expect(JSON.parse(text)).not.toHaveProperty('ciphersuite');
    expect(parseAppDeviceGrantMessage(text)).toEqual({ grant, message });
  });

  it('round trips a signing-only v2 grant', () => {
    const grant = signingGrant();
    const message = buildAppDeviceGrantMessage(grant);
    expect(
      parseAppDeviceGrantMessage(serializeAppDeviceGrantMessage(message))
    ).toEqual({ grant, message });
  });

  it('refuses a stored message with both or neither suite fields', () => {
    const message = buildAppDeviceGrantMessage(combinedGrant());
    const json = JSON.parse(serializeAppDeviceGrantMessage(message));
    expect(
      parseAppDeviceGrantMessage(JSON.stringify({ ...json, ciphersuite: 78 }))
    ).toBeNull();
    const { ciphersuites: _drop, ...neither } = json;
    expect(parseAppDeviceGrantMessage(JSON.stringify(neither))).toBeNull();
  });

  it.each([
    ['ciphersuites', { ciphersuites: [79, 78] }],
    ['ciphersuites', { ciphersuites: [4660] }],
    ['ciphersuites', { ciphersuites: [] }],
    ['ciphersuite', { ciphersuite: 0x004f }]
  ])('reports %s for a bad MLS suite set', (problem, overrides) => {
    expect(
      findAppDeviceGrantProblem(combinedGrant(overrides), NOW_SECONDS)
    ).toBe(problem);
  });

  it('accepts a set that pre-authorises an unaccepted suite', () => {
    expect(
      findAppDeviceGrantProblem(
        combinedGrant({ ciphersuites: [0x004e, 4660] }),
        NOW_SECONDS
      )
    ).toBeNull();
  });

  it('refuses suites on a signing-only grant', () => {
    expect(
      findAppDeviceGrantProblem(
        signingGrant({ ciphersuites: [0x004e] }),
        NOW_SECONDS
      )
    ).toBe('ciphersuite');
  });

  it('honours a v1 app grant only for 0x004F', () => {
    const v1 = (ciphersuite: number): AppDeviceGrant => ({
      wallet: WALLET,
      device_key: SIGNING_KEY,
      scopes: ['post', 'edit', 'delete', 'react'],
      mls_device_key: MLS_KEY,
      ciphersuite,
      issued_at: ISSUED_AT,
      expires_at: EXPIRES_AT,
      origin: '6529 Desktop'
    });
    expect(findAppDeviceGrantProblem(v1(0x004f), NOW_SECONDS)).toBeNull();
    expect(findAppDeviceGrantProblem(v1(0x004e), NOW_SECONDS)).toBe(
      'ciphersuite'
    );
  });
});
