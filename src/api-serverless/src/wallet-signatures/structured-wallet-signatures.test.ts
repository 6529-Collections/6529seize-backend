import { ethers } from 'ethers';
import {
  buildStructuredWalletSignatureMessage,
  clearStructuredWalletSignatureReplayCacheForTests,
  getDefaultStructuredWalletSignatureAudience,
  getStructuredWalletSignatureAudienceForHost,
  hashStructuredWalletSignaturePayload,
  isStructuredSignatureAudienceAllowed,
  parseStructuredWalletSignatureMessage,
  verifyStructuredWalletSignature
} from './structured-wallet-signatures';

const EIP1271_MAGIC_VALUE = '0x1626ba7e';

describe('structured wallet signatures', () => {
  const wallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  );
  const otherWallet = new ethers.Wallet(
    '0x59c6995e998f97a5a0044966f094538e9d874d2fe3df31d0f01e3be7f0ca0a84'
  );
  const issuedAt = new Date('2026-06-10T00:00:00.000Z');
  const getExpirationTime = () => new Date(Date.now() + 60_000);

  beforeEach(() => {
    clearStructuredWalletSignatureReplayCacheForTests();
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = 'example.com';
    process.env.ALCHEMY_API_KEY = 'test-key';
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
    delete process.env.AUTH_SIGNATURE_ALLOWED_AUDIENCES;
    delete process.env.AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES;
    delete process.env.AUTH_WEB_CREDENTIAL_ORIGINS;
    delete process.env.WEB_APP_ADDITIONAL_ORIGINS;
    delete process.env.WEB_APP_ORIGIN;
    delete process.env.API_BASE_URL;
  });

  afterEach(() => {
    delete process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS;
    delete process.env.AUTH_SIGNATURE_ALLOWED_AUDIENCES;
    delete process.env.AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES;
    delete process.env.AUTH_WEB_CREDENTIAL_ORIGINS;
    delete process.env.ALCHEMY_API_KEY;
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
    delete process.env.WEB_APP_ADDITIONAL_ORIGINS;
    delete process.env.WEB_APP_ORIGIN;
    delete process.env.API_BASE_URL;
    jest.restoreAllMocks();
  });

  it('derives accepted signature audiences from API hosts', () => {
    expect(isStructuredSignatureAudienceAllowed('api.6529.io')).toBe(true);
    expect(isStructuredSignatureAudienceAllowed('api.staging.6529.io')).toBe(
      true
    );
    expect(
      getStructuredWalletSignatureAudienceForHost('api.staging.6529.io')
    ).toBe('api.staging.6529.io');
    expect(
      getStructuredWalletSignatureAudienceForHost('api.staging.6529.io:443')
    ).toBe('api.staging.6529.io');
    expect(getStructuredWalletSignatureAudienceForHost('evil.example')).toBe(
      null
    );
  });

  it('uses API_BASE_URL as the default audience fallback', () => {
    process.env.API_BASE_URL = 'https://api.staging.6529.io/api';

    expect(getDefaultStructuredWalletSignatureAudience()).toBe(
      'api.staging.6529.io'
    );
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
      audience: 'api.6529.io',
      domain: 'example.com',
      wallet: wallet.address.toLowerCase(),
      chainId: 1,
      action: 'create_drop',
      payloadHash,
      purpose: 'Sign this message to create a 6529 drop.'
    });
  });

  it('parses optional client origin and session type fields', () => {
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'example.com',
      clientOrigin: 'https://example.com',
      sessionType: 'first_party_web',
      wallet: wallet.address,
      issuedAt,
      expirationTime: getExpirationTime(),
      nonce: 'login-nonce-with-origin',
      action: 'login',
      purpose: 'Sign this message to authenticate with 6529.'
    });

    expect(parseStructuredWalletSignatureMessage(message)).toMatchObject({
      audience: 'api.6529.io',
      domain: 'example.com',
      clientOrigin: 'https://example.com',
      sessionType: 'first_party_web'
    });

    const desktopMessage = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'desktop',
      sessionType: 'desktop',
      wallet: wallet.address,
      issuedAt,
      expirationTime: getExpirationTime(),
      nonce: 'login-nonce-desktop-session',
      action: 'login',
      purpose: 'Sign this message to authenticate with 6529.'
    });

    expect(parseStructuredWalletSignatureMessage(desktopMessage)).toMatchObject(
      {
        domain: 'desktop',
        sessionType: 'desktop'
      }
    );
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

  it('accepts external structured signatures from unregistered client domains', async () => {
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = '6529.io';
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'community-client.example',
      sessionType: 'external_client',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'external-client-login-nonce',
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
        expectedKind: 'authentication',
        consumeNonce: false
      })
    ).resolves.toBe(wallet.address.toLowerCase());
  });

  it('rejects first-party web signatures from unregistered domains', async () => {
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = '6529.io';
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'community-client.example',
      sessionType: 'first_party_web',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'first-party-unregistered-domain-nonce',
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
        expectedKind: 'authentication',
        requireAllowedDomain: true,
        consumeNonce: false
      })
    ).resolves.toBeNull();
  });

  it('accepts first-party web signatures from registered domains', async () => {
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'example.com',
      sessionType: 'first_party_web',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'first-party-registered-domain-nonce',
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
        expectedKind: 'authentication',
        requireAllowedDomain: true,
        consumeNonce: false
      })
    ).resolves.toBe(wallet.address.toLowerCase());
  });

  it('accepts first-party web signatures from WEB_APP_ORIGIN', async () => {
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = '';
    process.env.WEB_APP_ORIGIN = 'https://preview.6529.io/path';
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'preview.6529.io',
      sessionType: 'first_party_web',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'first-party-web-app-origin-domain-nonce',
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
        expectedKind: 'authentication',
        requireAllowedDomain: true,
        consumeNonce: false
      })
    ).resolves.toBe(wallet.address.toLowerCase());
  });

  it('accepts first-party web signatures from configured domain suffixes', async () => {
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = '';
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES = 'staging.6529.io';
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'app.staging.6529.io',
      sessionType: 'first_party_web',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'first-party-suffix-domain-nonce',
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
        expectedKind: 'authentication',
        requireAllowedDomain: true,
        consumeNonce: false
      })
    ).resolves.toBe(wallet.address.toLowerCase());
  });

  it('rejects first-party web signatures from lookalike domain suffixes', async () => {
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = '';
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES = 'staging.6529.io';
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'fake-staging.6529.io',
      sessionType: 'first_party_web',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'first-party-lookalike-suffix-domain-nonce',
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
        expectedKind: 'authentication',
        requireAllowedDomain: true,
        consumeNonce: false
      })
    ).resolves.toBeNull();
  });

  it('rejects structured signatures for unsupported API audiences', async () => {
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      audience: 'untrusted-api.example',
      domain: 'example.com',
      sessionType: 'external_client',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'unsupported-audience-nonce',
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
        expectedKind: 'authentication',
        consumeNonce: false
      })
    ).resolves.toBeNull();
  });

  it('accepts EIP-1271 signatures without relying on a Safe-wallet hint', async () => {
    const contract = {
      isValidSignature: jest.fn().mockResolvedValue(EIP1271_MAGIC_VALUE)
    };
    const contractConstructor = jest.fn().mockImplementation(() => contract);
    jest
      .spyOn(ethers, 'Contract', 'get')
      .mockReturnValue(
        contractConstructor as unknown as typeof ethers.Contract
      );
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'example.com',
      wallet: wallet.address,
      expirationTime: getExpirationTime(),
      nonce: 'eip-1271-login-nonce',
      action: 'login',
      purpose: 'Sign this message to authenticate with 6529.'
    });
    const signatureFromDifferentEoa = await otherWallet.signMessage(message);

    await expect(
      verifyStructuredWalletSignature({
        message,
        signature: signatureFromDifferentEoa,
        expectedAddress: wallet.address,
        expectedChainId: 1,
        expectedAction: 'login',
        expectedKind: 'authentication',
        consumeNonce: false
      })
    ).resolves.toBe(wallet.address.toLowerCase());

    expect(contract.isValidSignature).toHaveBeenCalledWith(
      ethers.hashMessage(message),
      signatureFromDifferentEoa
    );
  });

  it('rejects EIP-1271 signatures on unsupported chains without falling back to mainnet', async () => {
    const contractConstructor = jest.fn();
    jest
      .spyOn(ethers, 'Contract', 'get')
      .mockReturnValue(
        contractConstructor as unknown as typeof ethers.Contract
      );
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      domain: 'example.com',
      wallet: wallet.address,
      chainId: 137,
      expirationTime: getExpirationTime(),
      nonce: 'eip-1271-polygon-login-nonce',
      action: 'login',
      purpose: 'Sign this message to authenticate with 6529.'
    });
    const signatureFromDifferentEoa = await otherWallet.signMessage(message);

    await expect(
      verifyStructuredWalletSignature({
        message,
        signature: signatureFromDifferentEoa,
        expectedAddress: wallet.address,
        expectedChainId: 137,
        expectedAction: 'login',
        expectedKind: 'authentication',
        consumeNonce: false
      })
    ).resolves.toBeNull();

    expect(contractConstructor).not.toHaveBeenCalled();
  });
});
