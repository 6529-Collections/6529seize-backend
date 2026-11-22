import {
  adminRecordBody,
  intentSha256,
  MINT_ADMIN_RECORD_TYPE,
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
