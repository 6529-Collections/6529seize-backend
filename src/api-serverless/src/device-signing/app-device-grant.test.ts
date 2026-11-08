import { TypedDataEncoder, Wallet } from 'ethers';
import { E2EE_GRANT_DOMAIN } from '@/e2ee/e2ee-grant';
import fc from 'fast-check';
import {
  APP_DEVICE_GRANT_DOMAIN,
  APP_DEVICE_GRANT_TYPES,
  AppDeviceGrant,
  buildAppDeviceGrantMessage,
  computeAppDeviceGrantId,
  findAppDeviceGrantProblem,
  findAppDeviceGrantRegistrationProblem,
  isAppDeviceGrantMessage,
  parseAppDeviceGrantMessage,
  renderAppDeviceGrantStatement,
  serializeAppDeviceGrantMessage,
  verifyAppDeviceGrant
} from './app-device-grant';

// Shared app-grant vectors. The frontend pins the same values in
// __tests__/lib/device-signing/app-grant-vectors.ts; keep them identical.
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
const SIGNING_STATEMENT =
  "Turn on signed messages on this device until 16 Apr 2027. This device will sign your posts, edits, deletes and reactions so anyone can verify they came from your wallet. It can't move funds, change your handle, add devices or act as an admin. No transaction, no gas, no token approvals. (Device key d75a9801...f707511a)";
const SIGNING_GRANT_ID =
  '0x82c7577579d677929ef813cff39ffae1bacd6f1ec1e858687105cfae289d0b58';
const SIGNING_SIGNATURE =
  '0x69929366712f0057f41a94a75751ff2d5bc8185378c8f9c7dd89b3ea49d96f7553adf2b2a37572f097bc10227832da7ad9ae96d90ad21680167fa5b067bf31141c';
const COMBINED_STATEMENT =
  "Turn on signed messages on this device until 16 Apr 2027. This device will sign your posts, edits, deletes and reactions so anyone can verify they came from your wallet. It will also encrypt (send) and decrypt (read) your end-to-end encrypted messages, which 6529.io cannot read. It can't move funds, change your handle, add devices or act as an admin. No transaction, no gas, no token approvals. (Device key d75a9801...f707511a, encrypted messages key 3d4017c3...2af4660c)";
const COMBINED_GRANT_ID =
  '0xd0bbd126db3e79a4a79f55d3a75463242282268e231d4fc1b221a01ca2296bbd';
const COMBINED_SIGNATURE =
  '0x9b3615eb0e12c83a031239c055da1b29e1786f13c115044d2dae7e9c4f386f504da1b6ad0f8c4fad0aeb878fe290045b7c85cb02adc469404c31713c00b383d61b';

const NOW_SECONDS = ISSUED_AT + 60;

function signingGrant(overrides: Partial<AppDeviceGrant> = {}): AppDeviceGrant {
  return {
    wallet: WALLET,
    device_key: SIGNING_KEY,
    scopes: ['post', 'edit', 'delete', 'react'],
    mls_device_key: null,
    ciphersuite: null,
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    origin: '6529 Desktop',
    ...overrides
  };
}

const combinedGrant = (overrides: Partial<AppDeviceGrant> = {}) =>
  signingGrant({ mls_device_key: MLS_KEY, ciphersuite: 0x004f, ...overrides });

const noContractWallet = {
  hasCode: jest.fn().mockResolvedValue(false),
  isValidSignature: jest.fn().mockResolvedValue(false)
};

describe('app device grant', () => {
  describe('shared vectors', () => {
    it('renders the signing-only statement and digest', () => {
      const message = buildAppDeviceGrantMessage(signingGrant());
      expect(message.statement).toBe(SIGNING_STATEMENT);
      expect(message.mlsDeviceKey).toBe(`0x${'0'.repeat(64)}`);
      expect(message.ciphersuite).toBe(0);
      expect(computeAppDeviceGrantId(message)).toBe(SIGNING_GRANT_ID);
    });

    it('renders the combined statement and digest', () => {
      const message = buildAppDeviceGrantMessage(combinedGrant());
      expect(message.statement).toBe(COMBINED_STATEMENT);
      expect(renderAppDeviceGrantStatement(combinedGrant())).toBe(
        COMBINED_STATEMENT
      );
      expect(computeAppDeviceGrantId(message)).toBe(COMBINED_GRANT_ID);
    });

    it('matches what a wallet signs for the typed data', async () => {
      const wallet = new Wallet(PRIVATE_KEY);
      expect(wallet.address.toLowerCase()).toBe(WALLET);
      await expect(
        wallet.signTypedData(
          APP_DEVICE_GRANT_DOMAIN,
          APP_DEVICE_GRANT_TYPES,
          buildAppDeviceGrantMessage(combinedGrant())
        )
      ).resolves.toBe(COMBINED_SIGNATURE);
    });
  });

  it('has its own domain separator although it shares the E2EE salt', () => {
    expect(TypedDataEncoder.hashDomain(APP_DEVICE_GRANT_DOMAIN)).not.toBe(
      TypedDataEncoder.hashDomain(E2EE_GRANT_DOMAIN)
    );
    expect(APP_DEVICE_GRANT_DOMAIN.salt).toBe(E2EE_GRANT_DOMAIN.salt);
  });

  describe('verifyAppDeviceGrant', () => {
    it('verifies an EOA signature of the signing-only grant', async () => {
      await expect(
        verifyAppDeviceGrant({
          grant: signingGrant(),
          signature: SIGNING_SIGNATURE,
          contractWalletVerifier: noContractWallet
        })
      ).resolves.toMatchObject({
        ok: true,
        grantId: SIGNING_GRANT_ID,
        verifiedVia: 'eoa'
      });
    });

    it('rejects a signature over other fields', async () => {
      await expect(
        verifyAppDeviceGrant({
          grant: signingGrant({ origin: '6529.io' }),
          signature: SIGNING_SIGNATURE,
          contractWalletVerifier: noContractWallet
        })
      ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
    });

    it('rejects a signature of the signing-only grant for the combined one', async () => {
      await expect(
        verifyAppDeviceGrant({
          grant: combinedGrant(),
          signature: SIGNING_SIGNATURE,
          contractWalletVerifier: noContractWallet
        })
      ).resolves.toEqual({ ok: false, reason: 'signer_mismatch' });
    });

    it('accepts an EIP-1271 contract wallet for the exact digest', async () => {
      const contract = {
        hasCode: jest.fn().mockResolvedValue(true),
        isValidSignature: jest.fn().mockResolvedValue(true)
      };
      await expect(
        verifyAppDeviceGrant({
          grant: combinedGrant(),
          signature: '0x1234',
          contractWalletVerifier: contract
        })
      ).resolves.toMatchObject({ ok: true, verifiedVia: 'eip1271' });
      expect(contract.isValidSignature).toHaveBeenCalledWith(
        WALLET,
        COMBINED_GRANT_ID,
        '0x1234'
      );
    });

    it('fails closed when the contract wallet cannot be read', async () => {
      await expect(
        verifyAppDeviceGrant({
          grant: combinedGrant(),
          signature: '0x1234',
          contractWalletVerifier: {
            hasCode: jest.fn().mockRejectedValue(new Error('rpc down')),
            isValidSignature: jest.fn()
          }
        })
      ).resolves.toEqual({ ok: false, reason: 'contract_wallet_unavailable' });
    });

    it('rejects a malformed signature', async () => {
      await expect(
        verifyAppDeviceGrant({
          grant: signingGrant(),
          signature: 'not-hex',
          contractWalletVerifier: noContractWallet
        })
      ).resolves.toEqual({ ok: false, reason: 'signature_format' });
    });
  });

  describe('field checks', () => {
    it.each([
      ['wallet_format', { wallet: WALLET.toUpperCase() }],
      ['device_key_format', { device_key: '0x1234' }],
      ['scopes', { scopes: ['react', 'post'] as never }],
      ['scopes', { scopes: ['edit'] as never }],
      ['scopes', { scopes: ['post', 'post'] as never }],
      ['ciphersuite', { ciphersuite: 0x004f }],
      ['origin', { origin: '' }],
      ['origin', { origin: 'x'.repeat(65) }],
      ['origin', { origin: 'café' }],
      ['expiry_alignment', { expires_at: EXPIRES_AT + 1 }],
      ['time_order', { expires_at: ISSUED_AT }],
      ['lifetime', { expires_at: ISSUED_AT + 182 * 86400 - (ISSUED_AT % 60) }],
      ['expired', { issued_at: 100, expires_at: 120 }]
    ])('reports %s', (problem, overrides) => {
      expect(
        findAppDeviceGrantProblem(signingGrant(overrides), NOW_SECONDS)
      ).toBe(problem);
    });

    it.each([
      ['mls_device_key_format', { mls_device_key: '0x12' }],
      ['mls_device_key_reused', { mls_device_key: SIGNING_KEY }],
      ['ciphersuite', { ciphersuite: 1 }],
      ['ciphersuite', { ciphersuite: 0x0052 }],
      // v1 grants are honoured for 0x004F only; 0x004E needs v2 (D172).
      ['ciphersuite', { ciphersuite: 0x004e }],
      ['ciphersuite', { ciphersuite: null }]
    ])('reports %s for the MLS key', (problem, overrides) => {
      expect(
        findAppDeviceGrantProblem(combinedGrant(overrides), NOW_SECONDS)
      ).toBe(problem);
    });

    it('accepts both forms', () => {
      expect(findAppDeviceGrantProblem(signingGrant(), NOW_SECONDS)).toBeNull();
      expect(
        findAppDeviceGrantProblem(combinedGrant(), NOW_SECONDS)
      ).toBeNull();
    });

    it('bounds when a grant may be registered', () => {
      expect(
        findAppDeviceGrantRegistrationProblem(signingGrant(), ISSUED_AT - 3600)
      ).toBe('issued_in_future');
      expect(
        findAppDeviceGrantRegistrationProblem(
          signingGrant(),
          ISSUED_AT + 2 * 86400
        )
      ).toBe('issued_too_long_ago');
      expect(
        findAppDeviceGrantRegistrationProblem(signingGrant(), NOW_SECONDS)
      ).toBeNull();
    });
  });

  describe('stored message', () => {
    it('round-trips both forms through JSON', () => {
      for (const grant of [signingGrant(), combinedGrant()]) {
        const message = buildAppDeviceGrantMessage(grant);
        const text = serializeAppDeviceGrantMessage(message);
        expect(isAppDeviceGrantMessage(text)).toBe(true);
        expect(parseAppDeviceGrantMessage(text)).toEqual({ grant, message });
      }
    });

    it('rejects a statement the fields do not render', () => {
      const message = buildAppDeviceGrantMessage(combinedGrant());
      const text = serializeAppDeviceGrantMessage({
        ...message,
        statement: SIGNING_STATEMENT
      });
      expect(parseAppDeviceGrantMessage(text)).toBeNull();
    });

    it('never mistakes a SIWE message for an app grant', () => {
      expect(
        isAppDeviceGrantMessage(
          '6529.io wants you to sign in with your Ethereum account:'
        )
      ).toBe(false);
    });

    it('never throws on arbitrary text', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          expect(() => parseAppDeviceGrantMessage(text)).not.toThrow();
        })
      );
    });
  });
});
