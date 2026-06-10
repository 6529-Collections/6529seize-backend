import { ethers } from 'ethers';
import {
  buildStructuredWalletSignatureMessage,
  clearStructuredWalletSignatureReplayCacheForTests,
  hashStructuredWalletSignaturePayload,
  parseStructuredWalletSignatureMessage,
  verifyStructuredWalletSignature
} from './structured-wallet-signatures';

describe('structured wallet signatures', () => {
  const wallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  );
  const issuedAt = new Date('2026-06-10T00:00:00.000Z');
  const getExpirationTime = () => new Date(Date.now() + 60_000);

  beforeEach(() => {
    clearStructuredWalletSignatureReplayCacheForTests();
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = 'example.com';
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
  });

  afterEach(() => {
    delete process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS;
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
  });

  it('parses versioned action messages', () => {
    const payloadHash = hashStructuredWalletSignaturePayload({
      b: 2,
      a: 1
    });
    const message = buildStructuredWalletSignatureMessage({
      kind: 'action',
      domain: 'example.com',
      wallet: wallet.address,
      issuedAt,
      expirationTime: getExpirationTime(),
      nonce: 'nonce-12345',
      action: 'create_drop',
      payloadHash,
      purpose: 'Sign this message to create a 6529 drop.'
    });

    expect(parseStructuredWalletSignatureMessage(message)).toMatchObject({
      kind: 'action',
      domain: 'example.com',
      wallet: wallet.address.toLowerCase(),
      chainId: 1,
      action: 'create_drop',
      payloadHash,
      purpose: 'Sign this message to create a 6529 drop.'
    });
  });

  it('parses field values that contain additional colons', () => {
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'example.com',
      wallet: wallet.address,
      issuedAt,
      expirationTime: getExpirationTime(),
      nonce: 'nonce-with-colon-value',
      action: 'login',
      purpose: 'Sign this message: authenticate with 6529.'
    });

    expect(parseStructuredWalletSignatureMessage(message)).toMatchObject({
      kind: 'authentication',
      purpose: 'Sign this message: authenticate with 6529.'
    });
  });

  it('verifies an EOA signature once and rejects nonce replay', async () => {
    const payloadHash = hashStructuredWalletSignaturePayload({ a: 1 });
    const message = buildStructuredWalletSignatureMessage({
      kind: 'action',
      domain: 'example.com',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'replay-nonce-1',
      action: 'add_rememe',
      payloadHash,
      purpose: 'Sign this message to add a 6529 ReMeme.'
    });
    const signature = await wallet.signMessage(message);

    await expect(
      verifyStructuredWalletSignature({
        message,
        signature,
        expectedAddress: wallet.address,
        expectedChainId: 1,
        expectedAction: 'add_rememe',
        expectedKind: 'action',
        expectedPayloadHash: payloadHash
      })
    ).resolves.toBe(wallet.address.toLowerCase());

    await expect(
      verifyStructuredWalletSignature({
        message,
        signature,
        expectedAddress: wallet.address,
        expectedChainId: 1,
        expectedAction: 'add_rememe',
        expectedKind: 'action',
        expectedPayloadHash: payloadHash
      })
    ).resolves.toBeNull();
  });

  it('rejects payload hash mismatches', async () => {
    const message = buildStructuredWalletSignatureMessage({
      kind: 'action',
      domain: 'example.com',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'payload-nonce-1',
      action: 'nextgen_admin',
      payloadHash: hashStructuredWalletSignaturePayload({ a: 1 }),
      purpose: 'Sign this message to perform a 6529 NextGen admin action.'
    });
    const signature = await wallet.signMessage(message);

    await expect(
      verifyStructuredWalletSignature({
        message,
        signature,
        expectedAddress: wallet.address,
        expectedChainId: 1,
        expectedAction: 'nextgen_admin',
        expectedKind: 'action',
        expectedPayloadHash: hashStructuredWalletSignaturePayload({ a: 2 })
      })
    ).resolves.toBeNull();
  });

  it('rejects chain id mismatches', async () => {
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'example.com',
      wallet: wallet.address,
      chainId: 11155111,
      expirationTime: getExpirationTime(),
      nonce: 'chain-nonce-1',
      action: 'login',
      purpose: 'Sign this message to authenticate with 6529.'
    });
    const signature = await wallet.signMessage(message);

    await expect(
      verifyStructuredWalletSignature({
        message,
        signature,
        expectedAddress: wallet.address,
        expectedChainId: 1,
        expectedAction: 'login',
        expectedKind: 'authentication'
      })
    ).resolves.toBeNull();
  });
});
