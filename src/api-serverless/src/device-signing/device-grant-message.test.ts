import fc from 'fast-check';
import {
  buildDeviceGrantUrn,
  computeDeviceGrantId,
  computeGrantExpiresAtSeconds,
  DEFAULT_DEVICE_LABEL,
  DeviceGrantTerms,
  formatGrantExpiryUtc,
  GRANT_TTL_SECONDS,
  isGrantLifetimeValid,
  joinScopesAsEnglish,
  parseDeviceGrantUrn,
  parseDeviceScopesParam,
  renderDeviceGrantStatement,
  sanitizeDeviceLabel
} from './device-grant-message';

// Shared DN1 contract vectors (section 6).
const VECTOR_DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const VECTOR_TERMS: DeviceGrantTerms = {
  keyType: 'ed25519',
  deviceKey: VECTOR_DEVICE_KEY,
  scopes: ['post', 'edit', 'delete', 'react'],
  expiresAtSeconds: 1807876800
};
const VECTOR_STATEMENT =
  'Sign in to 6529 and let this device post as you until 2027-04-16 12:00 UTC (device key d75a9801...f707511a). It may post, edit, delete and react. It cannot move funds, change your handle, add devices or act as an admin. This request does not create a blockchain transaction, cost gas, or approve tokens.';
const VECTOR_URN =
  'urn:6529:device-grant:v1:ed25519:d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a:post.edit.delete.react:1807876800';
const VECTOR_FULL_MESSAGE = [
  'https://staging.6529.io wants you to sign in with your Ethereum account:',
  '0x1111111111111111111111111111111111111111',
  '',
  VECTOR_STATEMENT,
  '',
  'URI: https://staging.6529.io',
  'Version: 1',
  'Chain ID: 1',
  'Nonce: a1b2c3d4e5f60718293a4b5c6d7e8f90',
  'Issued At: 2026-10-12T12:00:00.000Z',
  'Expiration Time: 2026-10-12T12:05:00.000Z',
  'Resources:',
  `- ${VECTOR_URN}`
].join('\n');
const VECTOR_GRANT_ID =
  '0xbfa3bda34f9f8db49268ce338e3f3719a4191e879825ae7d8ebd41fb1567bfac';

describe('device grant message', () => {
  describe('contract vectors', () => {
    it('renders the vector statement', () => {
      expect(renderDeviceGrantStatement(VECTOR_TERMS)).toBe(VECTOR_STATEMENT);
    });

    it('builds and parses the vector URN', () => {
      expect(buildDeviceGrantUrn(VECTOR_TERMS)).toBe(VECTOR_URN);
      expect(parseDeviceGrantUrn(VECTOR_URN)).toEqual(VECTOR_TERMS);
    });

    it('derives the vector grant id from the exact signed message', () => {
      expect(computeDeviceGrantId(VECTOR_FULL_MESSAGE)).toBe(VECTOR_GRANT_ID);
    });
  });

  describe('scopes', () => {
    it('defaults to post, edit, delete and react', () => {
      expect(parseDeviceScopesParam(undefined)).toEqual([
        'post',
        'edit',
        'delete',
        'react'
      ]);
    });

    it('returns scopes in canonical order', () => {
      expect(parseDeviceScopesParam('vote,react,post')).toEqual([
        'post',
        'react',
        'vote'
      ]);
    });

    it.each([
      ['missing post', 'edit,react'],
      ['duplicate', 'post,post'],
      ['unknown', 'post,admin'],
      ['empty item', 'post,'],
      ['uppercase', 'POST'],
      ['whitespace', 'post, edit'],
      ['empty', '']
    ])('rejects %s', (_name, raw) => {
      expect(parseDeviceScopesParam(raw)).toBeNull();
    });

    it.each([
      [['post'], 'post'],
      [['post', 'edit'], 'post and edit'],
      [['post', 'edit', 'delete'], 'post, edit and delete'],
      [
        ['post', 'edit', 'delete', 'react', 'vote'],
        'post, edit, delete, react and vote'
      ]
    ])('joins %j as %s', (scopes, expected) => {
      expect(joinScopesAsEnglish(scopes)).toBe(expected);
    });
  });

  describe('expiry', () => {
    it('is minute aligned and 180 days after the issuing minute', () => {
      const issuedAt = new Date('2026-10-18T12:00:59.999Z');
      expect(computeGrantExpiresAtSeconds(issuedAt)).toBe(1807876800);
      expect(GRANT_TTL_SECONDS).toBe(15552000);
    });

    it('formats the expiry as zero padded UTC minutes', () => {
      expect(formatGrantExpiryUtc(Date.UTC(2027, 0, 2, 3, 4) / 1000)).toBe(
        '2027-01-02 03:04'
      );
    });

    it('always produces a lifetime the parser accepts', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1_600_000_000_000, max: 4_000_000_000_000 }),
          (millis) => {
            const issuedAt = new Date(Math.floor(millis / 1000) * 1000);
            return isGrantLifetimeValid(
              computeGrantExpiresAtSeconds(issuedAt),
              issuedAt
            );
          }
        )
      );
    });

    it.each([
      ['not minute aligned', 1807876830],
      ['beyond 181 days', 1791806400 + 181 * 86400 + 60],
      ['not after issued at', 1791806400]
    ])('rejects an expiry that is %s', (_name, expiresAtSeconds) => {
      expect(
        isGrantLifetimeValid(
          expiresAtSeconds,
          new Date('2026-10-12T12:00:00.000Z')
        )
      ).toBe(false);
    });
  });

  describe('URN parsing', () => {
    const keyHex = VECTOR_DEVICE_KEY.slice(2);

    it.each([
      [
        'short key',
        `urn:6529:device-grant:v1:ed25519:${keyHex.slice(2)}:post:1807876800`
      ],
      [
        'uppercase key',
        `urn:6529:device-grant:v1:ed25519:${keyHex.toUpperCase()}:post:1807876800`
      ],
      [
        'unknown scope',
        `urn:6529:device-grant:v1:ed25519:${keyHex}:post.admin:1807876800`
      ],
      [
        'non canonical scopes',
        `urn:6529:device-grant:v1:ed25519:${keyHex}:edit.post:1807876800`
      ],
      [
        'missing post scope',
        `urn:6529:device-grant:v1:ed25519:${keyHex}:edit:1807876800`
      ],
      [
        'duplicate scope',
        `urn:6529:device-grant:v1:ed25519:${keyHex}:post.post:1807876800`
      ],
      [
        'unaligned expiry',
        `urn:6529:device-grant:v1:ed25519:${keyHex}:post:1807876801`
      ],
      [
        'leading zero expiry',
        `urn:6529:device-grant:v1:ed25519:${keyHex}:post:01807876800`
      ],
      [
        'other key type',
        `urn:6529:device-grant:v1:secp256k1:${keyHex}:post:1807876800`
      ],
      [
        'other version',
        `urn:6529:device-grant:v2:ed25519:${keyHex}:post:1807876800`
      ],
      ['trailing data', `${VECTOR_URN}:x`]
    ])('rejects %s', (_name, urn) => {
      expect(parseDeviceGrantUrn(urn)).toBeNull();
    });
  });

  describe('device label', () => {
    it.each([
      ['Chrome on macOS', 'Chrome on macOS'],
      ['  Firefox   (Linux)  ', 'Firefox (Linux)'],
      ['<script>alert(1)</script>', 'scriptalert(1)script'],
      ['Ünïcödé 😀', 'ncd'],
      ['', DEFAULT_DEVICE_LABEL],
      ['😀😀', DEFAULT_DEVICE_LABEL],
      [undefined, DEFAULT_DEVICE_LABEL],
      [null, DEFAULT_DEVICE_LABEL]
    ])('sanitizes %j to %j', (raw, expected) => {
      expect(sanitizeDeviceLabel(raw)).toBe(expected);
    });

    it('truncates to 48 characters without trailing spaces', () => {
      const label = sanitizeDeviceLabel(`${'a'.repeat(47)} ${'b'.repeat(20)}`);
      expect(label).toBe('a'.repeat(47));
    });

    it('only ever returns allowed characters', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 64 }), (raw) => {
          const label = sanitizeDeviceLabel(raw);
          return (
            /^[A-Za-z0-9 ._()-]{1,48}$/.test(label) &&
            label === label.trim() &&
            !label.includes('  ')
          );
        })
      );
    });
  });
});
