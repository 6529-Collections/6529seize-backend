import {
  ReadableEvent,
  ReadFilter,
  RelayRules,
  RelaySession
} from '@/rebuild/sources/relay-rules';

const WALLET = '0x00000000000000000000000000000000000000ee';
const OWNER = `0x${'dd'.repeat(32)}`;
const STREAM = `pv/${OWNER}`;
const NOW = 1_000_000;

const session: RelaySession = {
  wallet: WALLET,
  principal: null,
  roles: [],
  memberOf: [],
  until: null
};

/** A reader record for WALLET: a body grants, none revokes. */
const record = (
  id: string,
  anchor: number,
  body: unknown,
  claimedTime = 0
): ReadableEvent => ({
  id,
  wave: STREAM,
  kind: 9,
  refs: ['reader', WALLET],
  anchor,
  claimed_time: claimedTime,
  body: body === null ? null : JSON.stringify(body)
});

const post: ReadableEvent = {
  id: '0xpost',
  wave: STREAM,
  kind: 12,
  refs: ['settings'],
  anchor: 1,
  body: '{}'
};

const keeps = (filter: ReadFilter, event: ReadableEvent) =>
  filter === 'all' || (filter !== 'none' && filter(event));

/** Whether WALLET reads the owner's other events, given the log. */
function reads(log: ReadableEvent[], now = NOW): boolean {
  const filter = new RelayRules(new Set(), new Map()).filter(
    session,
    STREAM,
    [...log, post],
    now
  );
  return keeps(filter, post);
}

describe('pv reader records, as wave-inbox reads them', () => {
  it('follows the newest record: granted, revoked, granted until a time', () => {
    const granted = record('0x01', 10, {});
    const revoked = record('0x02', 20, null);
    const until = record('0x03', 30, { until: NOW + 1 });
    expect(reads([])).toBe(false);
    expect(reads([granted])).toBe(true);
    expect(reads([granted, revoked])).toBe(false);
    // An older grant arriving after a newer revocation changes nothing.
    expect(reads([revoked, granted])).toBe(false);
    expect(reads([granted, revoked, until])).toBe(true);
    // Run out: the grant's until has passed.
    expect(reads([granted, revoked, until], NOW + 1)).toBe(false);
  });

  it('orders by anchor, then claimed time, then id', () => {
    const grant = record('0x0a', 10, {}, 5);
    const laterRevoke = record('0x09', 10, null, 6);
    expect(reads([grant, laterRevoke])).toBe(false);
    const tieRevoke = record('0x0b', 10, null, 5);
    expect(reads([grant, tieRevoke])).toBe(false);
    const tieGrant = record('0x0c', 10, {}, 5);
    expect(reads([grant, tieRevoke, tieGrant])).toBe(true);
  });

  it('still shows the wallet the reader records that name it', () => {
    const revoked = record('0x02', 20, null);
    const filter = new RelayRules(new Set(), new Map()).filter(
      session,
      STREAM,
      [revoked, post],
      NOW
    );
    expect(keeps(filter, revoked)).toBe(true);
    expect(keeps(filter, post)).toBe(false);
  });

  it('ignores what is not a reader record for the wallet', () => {
    const other = {
      ...record('0x01', 10, {}),
      refs: ['reader', `0x${'11'.repeat(20)}`]
    };
    const badBody = record('0x02', 10, { until: 'soon' });
    const upperWallet = {
      ...record('0x03', 10, {}),
      refs: ['reader', WALLET.toUpperCase().replace('0X', '0x')]
    };
    expect(reads([other])).toBe(false);
    expect(reads([badBody])).toBe(false);
    expect(reads([upperWallet])).toBe(false);
  });
});
