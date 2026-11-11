import { ethers } from 'ethers';
import {
  buildStructuredWalletSignatureMessage,
  clearStructuredWalletSignatureReplayCacheForTests,
  isStructuredSignatureDomainAllowed,
  verifyStructuredWalletSignature
} from './structured-wallet-signatures';
import { getWebAppSignatureDomainsForApiHost } from '../web-app-origins';

const ENV = [
  'NODE_ENV',
  'AUTH_SIGNATURE_ALLOWED_DOMAINS',
  'AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES',
  'WEB_APP_ORIGIN',
  'WEB_APP_ADDITIONAL_ORIGINS',
  'AUTH_WEB_CREDENTIAL_ORIGINS',
  'API_BASE_URL'
] as const;

describe('structured signature domains scoped to the API host', () => {
  const saved: Partial<Record<(typeof ENV)[number], string>> = {};
  const wallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  );

  beforeEach(() => {
    for (const name of ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    process.env.NODE_ENV = 'production';
    clearStructuredWalletSignatureReplayCacheForTests();
  });

  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  it('derives the web-app domains from the API host', () => {
    expect(getWebAppSignatureDomainsForApiHost('api.6529.io')).toEqual([
      '6529.io'
    ]);
    expect(getWebAppSignatureDomainsForApiHost('api.staging.6529.io')).toEqual([
      'staging.6529.io'
    ]);
    expect(getWebAppSignatureDomainsForApiHost('unknown.example')).toEqual([]);
  });

  it('the production API no longer accepts the staging web domain', () => {
    const production = { apiHost: 'api.6529.io' };
    expect(isStructuredSignatureDomainAllowed('6529.io', production)).toBe(
      true
    );
    expect(
      isStructuredSignatureDomainAllowed('staging.6529.io', production)
    ).toBe(false);
  });

  it('the staging API keeps accepting its own web domain', () => {
    expect(
      isStructuredSignatureDomainAllowed('staging.6529.io', {
        apiHost: 'api.staging.6529.io'
      })
    ).toBe(true);
  });

  it('keeps the built-in production domains and configured domains on every host', () => {
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = 'partner.example';
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAIN_SUFFIXES = 'preview.6529.io';
    for (const apiHost of ['api.6529.io', 'api.staging.6529.io', undefined]) {
      for (const domain of [
        '6529.io',
        'www.6529.io',
        'app.6529.io',
        'partner.example',
        'x.preview.6529.io'
      ]) {
        expect(isStructuredSignatureDomainAllowed(domain, { apiHost })).toBe(
          true
        );
      }
    }
  });

  it('accepts a configured web-app origin on the production API', () => {
    process.env.WEB_APP_ADDITIONAL_ORIGINS = 'https://staging.6529.io';
    expect(
      isStructuredSignatureDomainAllowed('staging.6529.io', {
        apiHost: 'api.6529.io'
      })
    ).toBe(true);
  });

  it('without a scope keeps accepting every built-in web-app domain', () => {
    expect(isStructuredSignatureDomainAllowed('staging.6529.io')).toBe(true);
    expect(isStructuredSignatureDomainAllowed('6529.io')).toBe(true);
  });

  it('refuses a first-party web login for the staging domain on the production API', async () => {
    const message = buildStructuredWalletSignatureMessage({
      kind: 'authentication',
      audience: 'api.6529.io',
      domain: 'staging.6529.io',
      clientOrigin: 'https://staging.6529.io',
      sessionType: 'first_party_web',
      wallet: wallet.address,
      expirationTime: new Date(Date.now() + 60_000),
      nonce: 'scoped-domain-nonce-1',
      action: 'login',
      purpose: 'Sign this message to authenticate with 6529.'
    });
    const signature = await wallet.signMessage(message);
    const verify = (apiHost: string) =>
      verifyStructuredWalletSignature({
        message,
        signature,
        expectedAddress: wallet.address,
        expectedChainId: 1,
        expectedAction: 'login',
        expectedKind: 'authentication',
        requireAllowedDomain: true,
        domainScope: { apiHost },
        consumeNonce: false
      });

    await expect(verify('api.6529.io')).resolves.toBeNull();
    await expect(verify('api.staging.6529.io')).resolves.toBe(
      wallet.address.toLowerCase()
    );
  });
});
