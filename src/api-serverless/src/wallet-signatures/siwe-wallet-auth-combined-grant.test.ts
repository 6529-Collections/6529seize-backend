jest.mock('@/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null)
}));

import { ethers } from 'ethers';
import { SiweMessage } from 'siwe';
import {
  buildMlsDeviceGrantUrn,
  renderCombinedGrantStatement
} from '@/api/device-signing/combined-device-grant';
import {
  DeviceGrantTerms,
  renderDeviceGrantStatement,
  renderLegacyDeviceGrantStatement
} from '@/api/device-signing/device-grant-message';
import {
  createSiweWebAuthChallenge,
  parseSiweWebAuthMessage,
  signSiweWebAuthChallenge,
  verifySessionChallengeToken,
  verifySiweWebAuthSignature
} from './siwe-wallet-auth';

const SIGNING_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const MLS_KEY =
  '0x3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';
const OTHER_KEY = `0x${'ab'.repeat(32)}`;
const EXPIRES_AT = 1807876800;
const ISSUED_AT = '2026-10-18T12:00:00.000Z';
const SIGNING: DeviceGrantTerms = {
  keyType: 'ed25519',
  deviceKey: SIGNING_KEY,
  scopes: ['post', 'edit', 'delete', 'react'],
  expiresAtSeconds: EXPIRES_AT
};
const MLS = {
  deviceKey: MLS_KEY,
  ciphersuite: 1,
  expiresAtSeconds: EXPIRES_AT
};
const SIGNING_URN = `urn:6529:device-grant:v1:ed25519:${SIGNING_KEY.slice(2)}:post.edit.delete.react:${EXPIRES_AT}`;
const MLS_URN = buildMlsDeviceGrantUrn(MLS);
const JWT_SECRET = 'siwe-combined-grant-test-secret';

function message(overrides: Partial<SiweMessage> = {}): string {
  return new SiweMessage({
    scheme: 'https',
    domain: 'staging.6529.io',
    address: ethers.getAddress('0x1111111111111111111111111111111111111111'),
    statement: renderCombinedGrantStatement(SIGNING, MLS),
    uri: 'https://staging.6529.io',
    version: '1',
    chainId: 1,
    nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    issuedAt: ISSUED_AT,
    expirationTime: new Date(Date.parse(ISSUED_AT) + 5 * 60_000).toISOString(),
    resources: [SIGNING_URN, MLS_URN],
    ...overrides
  }).prepareMessage();
}

describe('SIWE combined sign-in grants (NC8)', () => {
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

  it('parses the shared combined vector into both grants', () => {
    const parsed = parseSiweWebAuthMessage(message());
    expect(parsed?.deviceGrant).toEqual(SIGNING);
    expect(parsed?.mlsDeviceGrant).toEqual(MLS);
  });

  it.each([
    ['current', renderDeviceGrantStatement(SIGNING)],
    ['legacy', renderLegacyDeviceGrantStatement(SIGNING)]
  ])(
    'keeps accepting %s signing-only grants without an MLS grant',
    (_name, statement) => {
      const parsed = parseSiweWebAuthMessage(
        message({ statement, resources: [SIGNING_URN] })
      );
      expect(parsed?.deviceGrant).toEqual(SIGNING);
      expect(parsed?.mlsDeviceGrant).toBeNull();
    }
  );

  it.each([
    [
      'the resources swapped',
      { resources: [MLS_URN, SIGNING_URN] } as Partial<SiweMessage>
    ],
    ['a third resource', { resources: [SIGNING_URN, MLS_URN, MLS_URN] }],
    [
      'the signing statement over both resources',
      { statement: renderDeviceGrantStatement(SIGNING) }
    ],
    ['the combined statement over one resource', { resources: [SIGNING_URN] }],
    [
      'another MLS key in the resource',
      {
        resources: [
          SIGNING_URN,
          buildMlsDeviceGrantUrn({ ...MLS, deviceKey: OTHER_KEY })
        ]
      }
    ],
    [
      'another MLS expiry',
      {
        resources: [
          SIGNING_URN,
          buildMlsDeviceGrantUrn({ ...MLS, expiresAtSeconds: EXPIRES_AT - 60 })
        ],
        statement: renderCombinedGrantStatement(SIGNING, {
          ...MLS,
          expiresAtSeconds: EXPIRES_AT - 60
        })
      }
    ],
    [
      'the signing key as the MLS key',
      {
        resources: [
          SIGNING_URN,
          buildMlsDeviceGrantUrn({ ...MLS, deviceKey: SIGNING_KEY })
        ],
        statement: renderCombinedGrantStatement(SIGNING, {
          ...MLS,
          deviceKey: SIGNING_KEY
        })
      }
    ],
    [
      'an edited encrypted-messages clause',
      {
        statement: renderCombinedGrantStatement(SIGNING, MLS).replace(
          'which 6529 cannot read',
          'which 6529 can read'
        )
      }
    ],
    ['a malformed MLS resource', { resources: [SIGNING_URN, `${MLS_URN}0`] }]
  ])('rejects %s', (_name, overrides) => {
    expect(parseSiweWebAuthMessage(message(overrides))).toBeNull();
  });

  it('issues a combined challenge the parser, envelope and verifier accept', async () => {
    const issuedAt = new Date(ISSUED_AT);
    const challenge = createSiweWebAuthChallenge({
      address: wallet.address,
      clientOrigin: 'https://6529.io',
      chainId: 1,
      issuedAt,
      deviceGrant: {
        deviceKey: SIGNING_KEY,
        scopes: ['post', 'edit', 'delete', 'react'],
        mlsDevice: { deviceKey: MLS_KEY, ciphersuite: 1 }
      }
    });
    expect(challenge.deviceGrant).toEqual(SIGNING);
    expect(challenge.mlsDeviceGrant).toEqual(MLS);
    const parsedSiwe = new SiweMessage(challenge.message);
    expect(parsedSiwe.resources).toEqual([SIGNING_URN, MLS_URN]);
    expect(parsedSiwe.statement).toBe(
      renderCombinedGrantStatement(SIGNING, MLS)
    );

    const token = signSiweWebAuthChallenge({
      challenge,
      apiAudience: 'api.6529.io',
      jwtSecret: JWT_SECRET
    });
    const now = new Date(issuedAt.getTime() + 1000);
    expect(
      verifySessionChallengeToken({
        token,
        expectedApiAudience: 'api.6529.io',
        jwtSecret: JWT_SECRET,
        now
      })
    ).toMatchObject({ format: 'siwe', message: challenge.message });

    const verified = await verifySiweWebAuthSignature({
      message: challenge.message,
      signature: await wallet.signMessage(challenge.message),
      expectedAddress: wallet.address,
      expectedChainId: 1,
      expectedClientOrigin: 'https://6529.io',
      now
    });
    expect(verified?.deviceGrant).toEqual(SIGNING);
    expect(verified?.mlsDeviceGrant).toEqual(MLS);
  });

  it('rejects a combined challenge signed by another wallet', async () => {
    const issuedAt = new Date(ISSUED_AT);
    const challenge = createSiweWebAuthChallenge({
      address: wallet.address,
      clientOrigin: 'https://6529.io',
      chainId: 1,
      issuedAt,
      deviceGrant: {
        deviceKey: SIGNING_KEY,
        scopes: ['post', 'edit', 'delete', 'react'],
        mlsDevice: { deviceKey: MLS_KEY, ciphersuite: 1 }
      }
    });
    const other = ethers.Wallet.createRandom();
    await expect(
      verifySiweWebAuthSignature({
        message: challenge.message,
        signature: await other.signMessage(challenge.message),
        expectedAddress: wallet.address,
        expectedChainId: 1,
        expectedClientOrigin: 'https://6529.io',
        now: new Date(issuedAt.getTime() + 1000)
      })
    ).resolves.toBeNull();
  });

  it('issues a signing-only challenge when no MLS device is requested', () => {
    const challenge = createSiweWebAuthChallenge({
      address: wallet.address,
      clientOrigin: 'https://6529.io',
      chainId: 1,
      issuedAt: new Date(ISSUED_AT),
      deviceGrant: {
        deviceKey: SIGNING_KEY,
        scopes: ['post', 'edit', 'delete', 'react'],
        mlsDevice: null
      }
    });
    expect(challenge.mlsDeviceGrant).toBeNull();
    expect(new SiweMessage(challenge.message).resources).toEqual([SIGNING_URN]);
  });

  it.each([
    ['the signing key', { deviceKey: SIGNING_KEY, ciphersuite: 1 }],
    ['ciphersuite 0', { deviceKey: MLS_KEY, ciphersuite: 0 }],
    ['a non-hex key', { deviceKey: `0x${'zz'.repeat(32)}`, ciphersuite: 1 }]
  ])('refuses to issue a combined challenge with %s', (_name, mlsDevice) => {
    expect(() =>
      createSiweWebAuthChallenge({
        address: wallet.address,
        clientOrigin: 'https://6529.io',
        chainId: 1,
        issuedAt: new Date(ISSUED_AT),
        deviceGrant: {
          deviceKey: SIGNING_KEY,
          scopes: ['post', 'edit', 'delete', 'react'],
          mlsDevice
        }
      })
    ).toThrow('Invalid SIWE MLS device grant');
  });
});
