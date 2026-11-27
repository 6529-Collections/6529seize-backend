import {
  adminRecordBody,
  intentSha256,
  MINT_ADMIN_RECORD_TYPE,
  MINT_USER_RECORD_TYPE,
  MintIntent,
  recordMismatch
} from './mint-log-intent';
import type { MintVerifiedRecord } from './mint-log-ports';

const WALLET = '0x0000000000000000000000000000000000000001';

const intent: MintIntent = {
  route: 'POST /distributions/:contract/:id/artist-airdrops',
  params: { contract: '0xabc', id: '100' },
  body: { csv: '0x0000000000000000000000000000000000000002,1' }
};

function record(
  overrides: Partial<MintVerifiedRecord> = {}
): MintVerifiedRecord {
  return {
    eventId: '0x' + 'e'.repeat(64),
    author: WALLET,
    refs: [MINT_ADMIN_RECORD_TYPE, 'request-1'],
    body: adminRecordBody('dist.airdrops', intent) as unknown as Record<
      string,
      unknown
    >,
    event: {},
    ...overrides
  };
}

describe('mint admin records', () => {
  it('hashes the intent independently of key order', () => {
    expect(
      intentSha256({
        body: { b: 1, a: [2, { d: 3, c: 4 }] },
        params: { y: '1', x: '2' },
        route: 'r'
      })
    ).toBe(
      intentSha256({
        route: 'r',
        params: { x: '2', y: '1' },
        body: { a: [2, { c: 4, d: 3 }], b: 1 }
      })
    );
  });

  it('hashes a collaboration reply to the vector the frontend pins too', () => {
    expect(
      intentSha256({
        route: 'POST /drops/:drop_id/collaborations/:invitation_id/response',
        params: { drop_id: 'drop', invitation_id: 'inv-1' },
        body: {
          action: 'DECLINE',
          artwork_hash: 'a'.repeat(64),
          terms_version: 'b'.repeat(64)
        }
      })
    ).toBe('7d159e21780275c8248076fc3908fa9a4df05f797c13a480728a0c4114e77f02');
  });

  it('accepts a mint.user record only as a user record', () => {
    const user = record({ refs: [MINT_USER_RECORD_TYPE, 'request-2'] });
    expect(
      recordMismatch(
        user,
        'dist.airdrops',
        intent,
        WALLET,
        MINT_USER_RECORD_TYPE
      )
    ).toBeNull();
    expect(recordMismatch(user, 'dist.airdrops', intent, WALLET)).toBe(
      'refs must be ["mint.admin", key]'
    );
  });

  it('hashes requests to the vectors the frontend pins too', () => {
    expect(
      intentSha256({
        route: 'POST /distributions/:contract/:id/artist-airdrops',
        params: {
          contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
          id: '100'
        },
        body: {
          csv: [
            '0x0000000000000000000000000000000000000001,2',
            '0x0000000000000000000000000000000000000002,1'
          ].join('\n')
        }
      })
    ).toBe('1688590332587dd1cf75b623b6c34daa64d50a83dfaf3ac21535a0ba57bbdb86');
    expect(
      intentSha256({
        route:
          'GET /subscriptions/allowlists/:contract/:token_id/:allowlist_id/:phase_id',
        params: {
          allowlist_id: 'a1',
          contract: '0xabc',
          phase_id: 'p1',
          token_id: '100'
        },
        body: null
      })
    ).toBe('8d59f391969e2a2756b6b8e9117a3331615d065f03b736618b49833549e72e89');
  });

  it('accepts the record for this request by the signed-in wallet', () => {
    expect(
      recordMismatch(record(), 'dist.airdrops', intent, WALLET)
    ).toBeNull();
    expect(
      recordMismatch(record(), 'dist.airdrops', intent, WALLET.toUpperCase())
    ).toBeNull();
  });

  it.each([
    ['another type', { refs: ['mint.other', 'k'] }, /refs/],
    ['no key', { refs: [MINT_ADMIN_RECORD_TYPE] }, /refs/],
    [
      'another author',
      { author: '0x0000000000000000000000000000000000000009' },
      /signed-in wallet/
    ],
    ['no body', { body: null }, /no body/]
  ])('refuses a record with %s', (_label, overrides, message) => {
    expect(
      recordMismatch(record(overrides), 'dist.airdrops', intent, WALLET)
    ).toMatch(message);
  });

  it('refuses a record for another action or another request', () => {
    expect(recordMismatch(record(), 'dist.normalize', intent, WALLET)).toMatch(
      /does not match/
    );
    expect(
      recordMismatch(
        record(),
        'dist.airdrops',
        { ...intent, body: { csv: 'changed' } },
        WALLET
      )
    ).toMatch(/does not match/);
  });

  it('refuses when nobody is signed in', () => {
    expect(recordMismatch(record(), 'dist.airdrops', intent, null)).toMatch(
      /signed-in wallet/
    );
  });
});
