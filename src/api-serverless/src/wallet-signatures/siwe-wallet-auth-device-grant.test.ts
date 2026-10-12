jest.mock('@/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null)
}));

import { ethers } from 'ethers';
import { SiweMessage } from 'siwe';
import {
  computeDeviceGrantId,
  DeviceGrantScope,
  GRANT_TTL_SECONDS,
  renderDeviceGrantStatement
} from '@/api/device-signing/device-grant-message';
import {
  createSiweWebAuthChallenge,
  parseSiweWebAuthMessage,
  signSiweWebAuthChallenge,
  SIWE_WALLET_AUTH_STATEMENT,
  verifySessionChallengeToken,
  verifySiweWebAuthSignature
} from './siwe-wallet-auth';

const KEY_HEX =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const DEVICE_KEY = `0x${KEY_HEX}`;
const VECTOR_STATEMENT =
  'Sign in to 6529 and let this device post as you until 2027-04-16 12:00 UTC (device key d75a9801...f707511a). It may post, edit, delete and react. It cannot move funds, change your handle, add devices or act as an admin. This request does not create a blockchain transaction, cost gas, or approve tokens.';
const VECTOR_URN = `urn:6529:device-grant:v1:ed25519:${KEY_HEX}:post.edit.delete.react:1807876800`;
const VECTOR_TERMS = {
  keyType: 'ed25519',
  deviceKey: DEVICE_KEY,
  scopes: ['post', 'edit', 'delete', 'react'],
  expiresAtSeconds: 1807876800
};
// 180 days before the vector expiry, i.e. when the server would issue it.
const GRANT_ISSUED_AT = '2026-10-18T12:00:00.000Z';
const JWT_SECRET = 'siwe-device-grant-test-secret';

function grantMessage(overrides: Partial<SiweMessage> = {}): string {
  return new SiweMessage({
    scheme: 'https',
    domain: 'staging.6529.io',
    address: ethers.getAddress('0x1111111111111111111111111111111111111111'),
    statement: VECTOR_STATEMENT,
    uri: 'https://staging.6529.io',
    version: '1',
    chainId: 1,
    nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    issuedAt: GRANT_ISSUED_AT,
    expirationTime: new Date(
      Date.parse(GRANT_ISSUED_AT) + 5 * 60 * 1000
    ).toISOString(),
    resources: [VECTOR_URN],
    ...overrides
  }).prepareMessage();
}

function urnFor(scopes: string, expiresAt: number, keyHex = KEY_HEX): string {
  return `urn:6529:device-grant:v1:ed25519:${keyHex}:${scopes}:${expiresAt}`;
}

// Issued At plus 181 days.
const MAX_EXPIRY = Date.parse(GRANT_ISSUED_AT) / 1000 + 181 * 86400;

// Statement and resource that agree, so only the lifetime check can fail.
function consistentGrant(
  expiresAtSeconds: number,
  scopes: DeviceGrantScope[] = ['post', 'edit', 'delete', 'react']
): Partial<SiweMessage> {
  return {
    statement: renderDeviceGrantStatement({
      keyType: 'ed25519',
      deviceKey: DEVICE_KEY,
      scopes,
      expiresAtSeconds
    }),
    resources: [urnFor(scopes.join('.'), expiresAtSeconds)]
  };
}

describe('SIWE device grant messages', () => {
  const wallet = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  );
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_SIGNATURE_ALLOWED_DOMAINS = '6529.io,staging.6529.io';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('accepts the contract vector statement and URN', () => {
    const parsed = parseSiweWebAuthMessage(grantMessage());
    expect(parsed?.deviceGrant).toEqual(VECTOR_TERMS);
  });

  it('reproduces the contract vector grant id', () => {
    const vectorMessage = grantMessage({
      issuedAt: '2026-10-12T12:00:00.000Z',
      expirationTime: '2026-10-12T12:05:00.000Z'
    });
    expect(computeDeviceGrantId(vectorMessage)).toBe(
      '0xbfa3bda34f9f8db49268ce338e3f3719a4191e879825ae7d8ebd41fb1567bfac'
    );
    // That message grants 186 days; the server never issues more than 181.
    expect(parseSiweWebAuthMessage(vectorMessage)).toBeNull();
  });

  it('keeps the plain login message without a device grant', () => {
    const parsed = parseSiweWebAuthMessage(
      grantMessage({
        statement: SIWE_WALLET_AUTH_STATEMENT,
        resources: undefined
      })
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.deviceGrant).toBeNull();
  });

  it.each([
    [
      'a tampered statement',
      { statement: VECTOR_STATEMENT.replace('2027', '2028') }
    ],
    [
      'the plain statement with a grant',
      { statement: SIWE_WALLET_AUTH_STATEMENT }
    ],
    ['the grant statement without a resource', { resources: undefined }],
    [
      'a short key',
      {
        resources: [
          urnFor('post.edit.delete.react', 1807876800, KEY_HEX.slice(2))
        ]
      }
    ],
    [
      'an uppercase key',
      {
        resources: [
          urnFor('post.edit.delete.react', 1807876800, KEY_HEX.toUpperCase())
        ]
      }
    ],
    [
      'an unknown scope',
      { resources: [urnFor('post.edit.delete.admin', 1807876800)] }
    ],
    [
      'scopes out of canonical order',
      { resources: [urnFor('post.delete.edit.react', 1807876800)] }
    ],
    ['two resources', { resources: [VECTOR_URN, VECTOR_URN] }],
    ['an unrelated resource', { resources: ['https://6529.io/resource'] }],
    [
      'an expiry not minute aligned',
      { resources: [urnFor('post.edit.delete.react', 1807876830)] }
    ],
    ['an expiry beyond 181 days', consistentGrant(MAX_EXPIRY + 60)],
    ['an expiry before Issued At', consistentGrant(1760000040)]
  ])('rejects %s', (_name, overrides) => {
    expect(
      parseSiweWebAuthMessage(grantMessage(overrides as Partial<SiweMessage>))
    ).toBeNull();
  });

  it('accepts a lifetime of exactly 181 days', () => {
    expect(
      parseSiweWebAuthMessage(grantMessage(consistentGrant(MAX_EXPIRY)))
        ?.deviceGrant?.expiresAtSeconds
    ).toBe(MAX_EXPIRY);
  });

  it('accepts a single post scope', () => {
    expect(
      parseSiweWebAuthMessage(
        grantMessage(consistentGrant(1807876800, ['post']))
      )?.deviceGrant?.scopes
    ).toEqual(['post']);
  });

  it('builds a grant challenge the parser, envelope and verifier accept', async () => {
    const issuedAt = new Date('2026-10-12T12:34:56.789Z');
    const challenge = createSiweWebAuthChallenge({
      address: wallet.address,
      clientOrigin: 'https://6529.io',
      chainId: 1,
      issuedAt,
      deviceGrant: { deviceKey: DEVICE_KEY, scopes: ['post', 'react'] }
    });
    const expectedExpiry =
      Math.floor(Date.parse('2026-10-12T12:34:00.000Z') / 1000) +
      GRANT_TTL_SECONDS;
    const urn = urnFor('post.react', expectedExpiry);

    expect(challenge.message).toContain(
      'It may post and react. It cannot move funds'
    );
    expect(challenge.message.endsWith(`Resources:\n- ${urn}`)).toBe(true);
    expect(challenge.deviceGrant).toEqual({
      keyType: 'ed25519',
      deviceKey: DEVICE_KEY,
      scopes: ['post', 'react'],
      expiresAtSeconds: expectedExpiry
    });

    const token = signSiweWebAuthChallenge({
      challenge,
      apiAudience: 'api.6529.io',
      jwtSecret: JWT_SECRET
    });
    expect(
      verifySessionChallengeToken({
        token,
        expectedApiAudience: 'api.6529.io',
        jwtSecret: JWT_SECRET,
        now: new Date(issuedAt.getTime() + 1000)
      })
    ).toMatchObject({ format: 'siwe', message: challenge.message });

    const verified = await verifySiweWebAuthSignature({
      message: challenge.message,
      signature: await wallet.signMessage(challenge.message),
      expectedAddress: wallet.address,
      expectedChainId: 1,
      expectedClientOrigin: 'https://6529.io',
      now: new Date(issuedAt.getTime() + 1000)
    });
    expect(verified).toMatchObject({
      address: wallet.address.toLowerCase(),
      chainId: 1,
      issuedAt: new Date('2026-10-12T12:34:56.000Z'),
      deviceGrant: challenge.deviceGrant
    });
  });

  it('builds the same plain challenge when no grant is requested', () => {
    const params = {
      address: wallet.address,
      clientOrigin: 'https://6529.io',
      chainId: 1,
      nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      issuedAt: new Date('2026-10-12T12:00:00.000Z')
    };
    const plain = createSiweWebAuthChallenge(params);
    expect(
      createSiweWebAuthChallenge({ ...params, deviceGrant: null })
    ).toEqual(plain);
    expect(plain.deviceGrant).toBeNull();
    expect(plain.message).not.toContain('Resources');
    expect(plain.message).toContain(`\n\n${SIWE_WALLET_AUTH_STATEMENT}\n\n`);
  });
});
