import fc from 'fast-check';
import {
  buildDeviceGrantUrn,
  computeDeviceGrantId,
  computeGrantExpiresAtSeconds,
  DEFAULT_DEVICE_LABEL,
  DeviceGrantScope,
  DeviceGrantTerms,
  formatGrantExpiryDateUtc,
  formatGrantExpiryUtc,
  GRANT_TTL_SECONDS,
  isDeviceGrantStatement,
  isGrantLifetimeValid,
  joinScopesAsEnglish,
  parseDeviceGrantUrn,
  parseDeviceScopesParam,
  renderDeviceGrantStatement,
  renderLegacyDeviceGrantStatement,
  sanitizeDeviceLabel
} from './device-grant-message';

// Shared DN1 contract vectors (section 6). The frontend pins the same grant
// statements and grant ids.
const VECTOR_DEVICE_KEY =
  '0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const VECTOR_TERMS: DeviceGrantTerms = {
  keyType: 'ed25519',
  deviceKey: VECTOR_DEVICE_KEY,
  scopes: ['post', 'edit', 'delete', 'react'],
  expiresAtSeconds: 1807876800
};
// The statement rendered into new grant challenges.
const VECTOR_STATEMENT =
  "Sign in to 6529 and turn on signed messages on this device until 16 Apr 2027. This device will sign your posts, edits, deletes and reactions so anyone can verify they came from your wallet. It can't move funds, change your handle, add devices or act as an admin. No transaction, no gas, no token approvals. (Device key d75a9801...f707511a)";
// The statement of grants issued before the current wording; still accepted.
const LEGACY_VECTOR_STATEMENT =
  'Sign in to 6529 and let this device post as you until 2027-04-16 12:00 UTC (device key d75a9801...f707511a). It may post, edit, delete and react. It cannot move funds, change your handle, add devices or act as an admin. This request does not create a blockchain transaction, cost gas, or approve tokens.';
const VECTOR_URN =
  'urn:6529:device-grant:v1:ed25519:d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a:post.edit.delete.react:1807876800';
function vectorFullMessage(statement: string): string {
  return [
    'https://staging.6529.io wants you to sign in with your Ethereum account:',
    '0x1111111111111111111111111111111111111111',
    '',
    statement,
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
}
const VECTOR_GRANT_ID =
  '0x570275df514a120bb521f4e45c6cdc6613101cd36e9e9cfa8a46a6a4fdda886c';
const LEGACY_VECTOR_GRANT_ID =
  '0xbfa3bda34f9f8db49268ce338e3f3719a4191e879825ae7d8ebd41fb1567bfac';
// The ERC-4361 statement charset (siwe-parser ABNF): no newline, no non-ASCII.
const ERC_4361_STATEMENT = /^[a-zA-Z0-9 !#$&-;=?@[\]_~]+$/;

function utcSeconds(
  year: number,
  monthIndex: number,
  day: number,
  hours: number,
  minutes: number
): number {
  return Date.UTC(year, monthIndex, day, hours, minutes) / 1000;
}

function termsWith(overrides: Partial<DeviceGrantTerms>): DeviceGrantTerms {
  return { ...VECTOR_TERMS, ...overrides };
}

describe('device grant message', () => {
  describe('contract vectors', () => {
    it('renders the current and legacy vector statements', () => {
      expect(renderDeviceGrantStatement(VECTOR_TERMS)).toBe(VECTOR_STATEMENT);
      expect(renderLegacyDeviceGrantStatement(VECTOR_TERMS)).toBe(
        LEGACY_VECTOR_STATEMENT
      );
    });

    it('builds and parses the vector URN', () => {
      expect(buildDeviceGrantUrn(VECTOR_TERMS)).toBe(VECTOR_URN);
      expect(parseDeviceGrantUrn(VECTOR_URN)).toEqual(VECTOR_TERMS);
    });

    it.each([
      ['current', VECTOR_STATEMENT, VECTOR_GRANT_ID],
      ['legacy', LEGACY_VECTOR_STATEMENT, LEGACY_VECTOR_GRANT_ID]
    ])(
      'derives the %s vector grant id from the exact signed message',
      (_name, statement, grantId) => {
        expect(computeDeviceGrantId(vectorFullMessage(statement))).toBe(
          grantId
        );
      }
    );
  });

  describe('statement', () => {
    it('renders the approved wording for the default scopes', () => {
      expect(
        renderDeviceGrantStatement(
          termsWith({ expiresAtSeconds: utcSeconds(2027, 3, 29, 0, 30) })
        )
      ).toBe(
        "Sign in to 6529 and turn on signed messages on this device until 29 Apr 2027. This device will sign your posts, edits, deletes and reactions so anyone can verify they came from your wallet. It can't move funds, change your handle, add devices or act as an admin. No transaction, no gas, no token approvals. (Device key d75a9801...f707511a)"
      );
    });

    it.each([
      [['post'], 'This device will sign your posts so anyone'],
      [
        ['post', 'edit'],
        'This device will sign your posts and edits so anyone'
      ],
      [
        ['post', 'react'],
        'This device will sign your posts and reactions so anyone'
      ],
      [
        ['post', 'edit', 'delete', 'react', 'vote'],
        'This device will sign your posts, edits, deletes, reactions and votes so anyone'
      ]
    ])('names what the device signs for %j', (scopes, expected) => {
      expect(
        renderDeviceGrantStatement(
          termsWith({ scopes: scopes as DeviceGrantScope[] })
        )
      ).toContain(expected);
    });

    it('keeps the legacy scope wording', () => {
      expect(
        renderLegacyDeviceGrantStatement(
          termsWith({ scopes: ['post', 'edit', 'delete', 'react', 'vote'] })
        )
      ).toContain('It may post, edit, delete, react and vote. ');
    });

    it('always renders one ERC-4361 statement line', () => {
      fc.assert(
        fc.property(
          fc.subarray(['edit', 'delete', 'react', 'vote'] as const),
          fc.integer({ min: 1_700_000_000, max: 4_000_000_000 }),
          fc.stringMatching(/^[0-9a-f]{64}$/),
          (extraScopes, expiresAt, keyHex) => {
            const terms = termsWith({
              deviceKey: `0x${keyHex}`,
              scopes: ['post', ...extraScopes],
              expiresAtSeconds: Math.floor(expiresAt / 60) * 60
            });
            return (
              ERC_4361_STATEMENT.test(renderDeviceGrantStatement(terms)) &&
              ERC_4361_STATEMENT.test(renderLegacyDeviceGrantStatement(terms))
            );
          }
        )
      );
    });

    it('accepts exactly the current or the legacy statement', () => {
      expect(isDeviceGrantStatement(VECTOR_STATEMENT, VECTOR_TERMS)).toBe(true);
      expect(
        isDeviceGrantStatement(LEGACY_VECTOR_STATEMENT, VECTOR_TERMS)
      ).toBe(true);
      expect(isDeviceGrantStatement(undefined, VECTOR_TERMS)).toBe(false);
    });

    it.each([
      ['scopes', 'posts, edits, deletes and', 'posts, edits and'],
      ['key', 'd75a9801...f707511a', 'd75a9801...f707511b'],
      ['expiry date', '16 Apr 2027', '17 Apr 2027'],
      ['expiry date with time', '16 Apr 2027', '16 Apr 2027 12:00 UTC'],
      ['capabilities', "It can't move funds", 'It can move funds'],
      ['trailing text', 'f707511a)', 'f707511a). Also vote.'],
      ['trailing period', 'f707511a)', 'f707511a).'],
      ['leading text', 'Sign in to 6529', 'Hi. Sign in to 6529'],
      ['curly apostrophe', "can't", 'can\u2019t'],
      ['Unicode ellipsis', 'd75a9801...f707511a', 'd75a9801\u2026f707511a'],
      ['lowercase key label', '(Device key', '(device key']
    ])('rejects the current statement with edited %s', (_name, from, to) => {
      const statement = VECTOR_STATEMENT.replace(from, to);
      expect(statement).not.toBe(VECTOR_STATEMENT);
      expect(isDeviceGrantStatement(statement, VECTOR_TERMS)).toBe(false);
    });

    it.each([
      ['scopes', 'post, edit, delete and', 'post, edit and'],
      ['key', 'd75a9801...f707511a', 'd75a9801...f707511b'],
      ['expiry minute', '12:00 UTC', '12:01 UTC'],
      ['trailing text', 'approve tokens.', 'approve tokens. Also vote.'],
      ['new date format', '2027-04-16 12:00 UTC', '16 Apr 2027']
    ])('rejects the legacy statement with edited %s', (_name, from, to) => {
      const statement = LEGACY_VECTOR_STATEMENT.replace(from, to);
      expect(statement).not.toBe(LEGACY_VECTOR_STATEMENT);
      expect(isDeviceGrantStatement(statement, VECTOR_TERMS)).toBe(false);
    });

    it.each([
      ['fewer scopes', { scopes: ['post', 'edit', 'delete'] }],
      ['more scopes', { scopes: ['post', 'edit', 'delete', 'react', 'vote'] }],
      ['another key', { deviceKey: `0x${'ab'.repeat(32)}` }],
      ['a later expiry day', { expiresAtSeconds: 1807876800 + 86400 }]
    ])('rejects both statements for terms with %s', (_name, overrides) => {
      const terms = termsWith(overrides as Partial<DeviceGrantTerms>);
      expect(isDeviceGrantStatement(VECTOR_STATEMENT, terms)).toBe(false);
      expect(isDeviceGrantStatement(LEGACY_VECTOR_STATEMENT, terms)).toBe(
        false
      );
    });

    it('binds the expiry minute in the URN; only the legacy statement repeats it', () => {
      const sameDay = termsWith({ expiresAtSeconds: 1807876800 + 60 });
      expect(isDeviceGrantStatement(VECTOR_STATEMENT, sameDay)).toBe(true);
      expect(isDeviceGrantStatement(LEGACY_VECTOR_STATEMENT, sameDay)).toBe(
        false
      );
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

    it('formats the legacy expiry as zero padded UTC minutes', () => {
      expect(formatGrantExpiryUtc(Date.UTC(2027, 0, 2, 3, 4) / 1000)).toBe(
        '2027-01-02 03:04'
      );
    });

    it.each([
      [utcSeconds(2026, 10, 5, 9, 0), '5 Nov 2026'],
      [utcSeconds(2027, 3, 29, 0, 30), '29 Apr 2027'],
      [utcSeconds(2027, 0, 1, 0, 0), '1 Jan 2027'],
      [utcSeconds(2026, 11, 31, 23, 59), '31 Dec 2026'],
      [utcSeconds(2028, 1, 29, 12, 0), '29 Feb 2028']
    ])('formats the expiry date %d as %s', (expiresAtSeconds, expected) => {
      expect(formatGrantExpiryDateUtc(expiresAtSeconds)).toBe(expected);
    });

    it('names every month with its English abbreviation', () => {
      const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec'
      ];
      months.forEach((month, index) => {
        expect(
          formatGrantExpiryDateUtc(utcSeconds(2027, index, 10, 12, 0))
        ).toBe(`10 ${month} 2027`);
      });
    });

    it('names the UTC date whatever the server time zone', () => {
      // Answer the local getters as a host elsewhere would; code that read
      // local getters would name the wrong day.
      const asHost = (offsetHours: number) => {
        const shift = (date: Date) =>
          new Date(date.getTime() + offsetHours * 60 * 60 * 1000);
        return [
          jest
            .spyOn(Date.prototype, 'getFullYear')
            .mockImplementation(function (this: Date) {
              return shift(this).getUTCFullYear();
            }),
          jest.spyOn(Date.prototype, 'getMonth').mockImplementation(function (
            this: Date
          ) {
            return shift(this).getUTCMonth();
          }),
          jest.spyOn(Date.prototype, 'getDate').mockImplementation(function (
            this: Date
          ) {
            return shift(this).getUTCDate();
          })
        ];
      };
      const westSpies = asHost(-7);
      try {
        expect(formatGrantExpiryDateUtc(utcSeconds(2027, 3, 29, 0, 30))).toBe(
          '29 Apr 2027'
        );
      } finally {
        westSpies.forEach((spy) => spy.mockRestore());
      }
      const eastSpies = asHost(14);
      try {
        expect(formatGrantExpiryDateUtc(utcSeconds(2026, 11, 31, 23, 59))).toBe(
          '31 Dec 2026'
        );
      } finally {
        eastSpies.forEach((spy) => spy.mockRestore());
      }
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
