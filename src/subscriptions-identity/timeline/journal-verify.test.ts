import fc from 'fast-check';
import {
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  SUBSCRIPTIONS_ADDRESS
} from '@/constants';
import { RecordKind } from '@/signed-records/record-kinds';
import type { RecordVerifyResult } from '@/signed-records/record-verify';
import { roundSubscriptionBalance } from '../engine/parity-money';
import type { JournalBody, JournalChange, JournalKind } from './journal';
import {
  EthereumFacts,
  ReplayedSubscriptionEvents,
  SignedEventLookup,
  verifyEntryMoney,
  verifyJournal
} from './journal-verify';

// Obviously fake keys, wallets and hashes.
const OPENING = 'a'.repeat(64);
const OTHER_OPENING = 'b'.repeat(64);
const P1 = `0x${'b1'.padStart(64, '0')}`;
const P2 = `0x${'b2'.padStart(64, '0')}`;
const W1 = `0x${'1'.padStart(40, '0')}`;
const W2 = `0x${'2'.padStart(40, '0')}`;
const AIRDROP = `0x${'a1'.padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const T = '2026-11-25 10:00:00.000000';
const EVENT = 'e'.repeat(32);

type Row = Record<string, unknown>;

function body(
  n: number,
  kind: JournalKind,
  inputs: Row,
  changes: JournalChange[],
  extra: Partial<JournalBody> = {}
): JournalBody {
  return {
    t: 'journal',
    v: 2,
    kind,
    n,
    part: 0,
    parts: 1,
    opening: OPENING,
    mode: 'truth',
    at_ms: 1_764_064_800_000 + n,
    inputs,
    changes,
    rekeys: [],
    checkpoint: null,
    ...extra
  };
}

const balanceRow = (identity: string, balance: number): Row => ({
  identity_key: identity,
  balance,
  created_at: T,
  updated_at: T
});

/** A balances change; `before` undefined means not captured. */
function balance(
  identity: string,
  before: number | null | undefined,
  after: number | null
): JournalChange {
  return {
    table: 'balances',
    key: { identity_key: identity },
    ...(before === undefined
      ? {}
      : { before: before === null ? null : balanceRow(identity, before) }),
    after: after === null ? null : balanceRow(identity, after)
  };
}

function topUpInputs(n: number, amount: number, identity = P1, from = W1) {
  return {
    hash: hash(n),
    block: 1000 + n,
    transaction_date: T,
    from_wallet: from,
    amount,
    identity_key: identity
  };
}

function topUpRow(inputs: ReturnType<typeof topUpInputs>): JournalChange {
  return {
    table: 'top_up',
    key: { hash: inputs.hash },
    before: null,
    after: {
      hash: inputs.hash,
      block: inputs.block,
      from_wallet: inputs.from_wallet,
      amount: inputs.amount,
      identity_key: inputs.identity_key,
      created_at: T,
      transaction_date: T
    }
  };
}

/** A top-up entry as the writer makes it. */
function topUp(
  n: number,
  amount: number,
  before: number | null,
  identity = P1
): JournalBody {
  const inputs = topUpInputs(n, amount, identity);
  return body(n, 'top-up', inputs, [
    balance(
      identity,
      before,
      before === null ? amount : roundSubscriptionBalance(before + amount)
    ),
    topUpRow(inputs)
  ]);
}

interface ChargeInput {
  readonly transaction: string;
  readonly identity_key: string;
  readonly token_count: number;
}

function charge(c: ChargeInput) {
  return {
    transaction: c.transaction,
    contract: MEMES_CONTRACT,
    token_id: 7,
    to_address: AIRDROP,
    token_count: c.token_count,
    identity_key: c.identity_key
  };
}

/** A redemption entry charging each identity from its balance, as the writer does. */
function redemption(
  n: number,
  charges: ChargeInput[],
  balances: Record<string, number | null>
): JournalBody {
  const changes: JournalChange[] = [];
  for (const [identity, before] of Object.entries(balances)) {
    let after = before ?? 0;
    for (const _ of charges.filter((c) => c.identity_key === identity)) {
      after = roundSubscriptionBalance(after - MEMES_MINT_PRICE);
    }
    changes.push(balance(identity, before, after));
  }
  const perRow = new Map<string, number>();
  for (const c of charges) {
    const key = `${c.transaction}|${c.identity_key}`;
    perRow.set(key, (perRow.get(key) ?? 0) + 1);
  }
  let id = n * 100;
  for (const [key, count] of Array.from(perRow.entries())) {
    const [transaction, identity] = key.split('|');
    changes.push({
      table: 'redeemed',
      key: { id: ++id },
      before: null,
      after: {
        id,
        identity_key: identity,
        transaction,
        count,
        value: MEMES_MINT_PRICE * count
      }
    });
  }
  changes.push({
    table: 'cursor',
    key: { id: 'redemption' },
    before: { id: 'redemption', block: 10, updated_at: 1 },
    after: { id: 'redemption', block: 20, updated_at: 2 }
  });
  return body(
    n,
    'redemption',
    { after_block: 10, through_block: 20, charges: charges.map(charge) },
    changes
  );
}

/** A fold entry as the writer makes it: W's balance deleted, I's the sum. */
function fold(
  n: number,
  identityBefore: number | null,
  walletBefore: number | null
): JournalBody {
  const changes: JournalChange[] = [];
  if (identityBefore !== null || walletBefore !== null) {
    changes.push(
      balance(P1, identityBefore, (identityBefore ?? 0) + (walletBefore ?? 0))
    );
  }
  if (walletBefore !== null) {
    changes.push(balance(W2, walletBefore, null));
  }
  return body(
    n,
    'fold',
    { wallet: W2, identity_key: P1, at_text: T },
    changes,
    { rekeys: [{ from: W2, to: P1 }] }
  );
}

function choice(n: number, eventId = EVENT): JournalBody {
  return body(
    n,
    'choice',
    {
      event_id: eventId,
      owner: P1,
      type: 'subs.mode',
      key: '',
      anchor: 100,
      claimed_time: 1
    },
    [
      {
        table: 'mode',
        key: { identity_key: P1 },
        before: null,
        after: { identity_key: P1, automatic: 1, subscribe_all_editions: 0 }
      }
    ]
  );
}

function build(n: number, parts = 1): JournalBody[] {
  const inputs = { contract: MEMES_CONTRACT, token_id: 7, build_at_ms: 1 };
  return Array.from({ length: parts }, (_, part) =>
    body(
      n,
      'build',
      inputs,
      [
        {
          table: 'final',
          key: { id: n * 10 + part },
          before: null,
          after: { id: n * 10 + part, identity_key: P1, redeemed_count: 0 }
        }
      ],
      { part, parts }
    )
  );
}

const MINT_TX = hash(900);
const MINT_KEY = `${MINT_TX}|${MEMES_CONTRACT.toLowerCase()}|7|${AIRDROP}`;

/** A journal that keeps every rule, in log order. */
function goodJournal(): JournalBody[] {
  return [
    topUp(1, 0.1, null),
    // Another opening's entry (an earlier rehearsal) is skipped.
    { ...topUp(2, 0.5, null, P2), opening: OTHER_OPENING },
    topUp(3, 0.2, 0.1),
    fold(4, roundSubscriptionBalance(0.1 + 0.2), 0.05),
    ...build(5, 2),
    body(6, 'checkpoint', {}, [], {
      checkpoint: { through_n: 5, state_sha256: 'c'.repeat(64) }
    }),
    redemption(
      7,
      [
        { transaction: MINT_TX, identity_key: P1, token_count: 2 },
        { transaction: MINT_TX, identity_key: P1, token_count: 2 }
      ],
      { [P1]: roundSubscriptionBalance(0.1 + 0.2) + 0.05 }
    ),
    choice(8),
    body(
      9,
      'upload',
      { contract: MEMES_CONTRACT, token_id: 7, date: '', upload_url: 'ar://x' },
      [
        {
          table: 'upload',
          key: { contract: MEMES_CONTRACT, token_id: 7 },
          before: null,
          after: { contract: MEMES_CONTRACT, token_id: 7, upload_url: 'ar://x' }
        }
      ]
    )
  ];
}

/** Ethereum as the good journal has it. */
function ethereumFixture(): EthereumFacts & { calls: number } {
  const facts = {
    calls: 0,
    async topUp(h: string) {
      facts.calls++;
      const n = parseInt(h.slice(2), 16);
      const amounts: Record<number, number> = { 1: 0.1, 3: 0.2, 10: 0.3 };
      return amounts[n] === undefined
        ? null
        : {
            from: W1.toUpperCase().replace('0X', '0x'),
            to: SUBSCRIPTIONS_ADDRESS.toLowerCase(),
            valueEth: amounts[n],
            block: 1000 + n
          };
    },
    async mintedTo(h: string, contract: string, tokenId: number, to: string) {
      facts.calls++;
      return h === MINT_TX &&
        contract === MEMES_CONTRACT &&
        tokenId === 7 &&
        to === AIRDROP
        ? 2
        : 0;
    }
  };
  return facts;
}

const eventsFixture = (
  events: Record<string, Awaited<ReturnType<SignedEventLookup['find']>>>
): SignedEventLookup => ({
  find: async (id) => events[id] ?? null
});

const GOOD_EVENT = {
  type: 'subs.mode',
  key: '',
  body: { automatic: true },
  owner: P1
};

async function verify(
  bodies: JournalBody[],
  options: Partial<Parameters<typeof verifyJournal>[1]> = {}
) {
  return verifyJournal(bodies, { openingSha256: OPENING, ...options });
}

describe('verifyJournal', () => {
  it('passes a journal that keeps every rule, against Ethereum and the signed records', async () => {
    const ethereum = ethereumFixture();
    const report = await verify(goodJournal(), {
      ethereum,
      events: eventsFixture({ [EVENT]: GOOD_EVENT })
    });
    expect(report.failures).toEqual([]);
    expect(report).toMatchObject({
      openingSha256: OPENING,
      writes: 8,
      counts: { topUps: 2, charges: 2, mints: 1, choices: 1 },
      checked: { ethereum: true, events: true }
    });
    // Two top-ups and one mint.
    expect(ethereum.calls).toBe(3);
  });

  it('makes no call without ports, and says what it left unchecked', async () => {
    const report = await verify(goodJournal());
    expect(report.failures).toEqual([]);
    expect(report.checked).toEqual({ ethereum: false, events: false });
  });

  describe('a top-up', () => {
    it('fails when the balance moves by another amount', async () => {
      const wrong = topUp(3, 0.2, 0.1);
      (wrong.changes[0].after as Row).balance = 0.31;
      const report = await verify([topUp(1, 0.1, null), wrong]);
      expect(report.failures).toEqual([
        `n=3 top-up: the balance of ${P1} is 0.31 after a top-up of 0.2 to 0.1; expected 0.3`
      ]);
    });

    it('opens a first balance at the amount, unrounded', async () => {
      const amount = 0.1234567;
      expect(verifyEntryMoney([topUp(1, amount, null)])).toEqual([]);
      const rounded = topUp(1, amount, null);
      (rounded.changes[0].after as Row).balance =
        roundSubscriptionBalance(amount);
      expect(verifyEntryMoney([rounded])).toEqual([
        `n=1 top-up: the balance of ${P1} is 0.12346 after a top-up of ${amount} to no balance; expected ${amount}`
      ]);
    });

    it('passes a 0 ETH top-up that leaves a balance as it was, and fails any other', async () => {
      const zero = topUp(3, 0, 0.1);
      zero.changes.splice(0, 1);
      expect(verifyEntryMoney([zero])).toEqual([]);
      const lost = topUp(3, 0.2, 0.1);
      lost.changes.splice(0, 1);
      expect(verifyEntryMoney([lost])).toEqual([
        `n=3 top-up: the top-up leaves the balance of ${P1} as it was`
      ]);
    });

    it('fails when the hash is credited twice, in any case', async () => {
      const again = topUp(0xac, 0.1, 0.1);
      const inputs = again.inputs as { hash: string };
      inputs.hash = hash(0xab).toUpperCase().replace('0X', '0x');
      (again.changes[1].after as Row).hash = inputs.hash;
      const report = await verify([topUp(0xab, 0.1, null), again]);
      expect(report.failures).toEqual([
        `n=172 top-up: top-up ${hash(0xab)} is credited again (first at n=171)`
      ]);
    });

    it('fails when the opening file already holds the hash', async () => {
      const report = await verify([topUp(1, 0.1, null)], {
        opening: {
          topUps: [{ hash: hash(1) } as never],
          redeemed: []
        }
      });
      expect(report.failures).toEqual([
        `n=1 top-up: top-up ${hash(1)} is already in the opening file`
      ]);
    });

    it('fails when its top_up row or other balances disagree with its inputs', async () => {
      const entry = topUp(1, 0.1, null);
      (entry.changes[1].after as Row).identity_key = P2;
      entry.changes.push(balance(P2, 1, 2));
      expect(verifyEntryMoney([entry])).toEqual([
        `n=1 top-up: a top-up for ${P1} changes the balance of ${P2}`,
        `n=1 top-up: the top_up row does not match the entry's inputs in identity_key`
      ]);
    });

    it('fails when the balance before was not captured', async () => {
      const entry = body(1, 'top-up', topUpInputs(1, 0.1), [
        balance(P1, undefined, 0.1),
        topUpRow(topUpInputs(1, 0.1))
      ]);
      expect(verifyEntryMoney([entry])).toEqual([
        `n=1 top-up: the balance of ${P1} changes with no before captured`
      ]);
    });

    it('fails against Ethereum when the transfer is missing or differs', async () => {
      const missing = topUp(5, 0.1, null);
      const otherValue = topUp(10, 0.25, 0.1);
      const report = await verify([missing, otherValue], {
        ethereum: ethereumFixture()
      });
      expect(report.failures).toEqual([
        `n=5 top-up: no ETH transfer ${hash(5)} on Ethereum`,
        `n=10 top-up: the transfer ${hash(10)} on Ethereum differs in value`
      ]);
    });
  });

  describe('a redemption', () => {
    it('fails when the balance moves by less than the mint price per charge', async () => {
      const entry = redemption(
        7,
        [
          { transaction: MINT_TX, identity_key: P1, token_count: 2 },
          { transaction: MINT_TX, identity_key: P1, token_count: 2 }
        ],
        { [P1]: 1 }
      );
      (entry.changes[0].after as Row).balance = roundSubscriptionBalance(
        1 - MEMES_MINT_PRICE
      );
      expect(verifyEntryMoney([entry])).toEqual([
        `n=7 redemption: the balance of ${P1} is 0.93471 after 2 charges from 1; expected 0.86942`
      ]);
    });

    it('charges a missing balance from zero, below zero', async () => {
      const entry = redemption(
        7,
        [{ transaction: MINT_TX, identity_key: P1, token_count: 1 }],
        { [P1]: null }
      );
      expect(entry.changes[0].after).toMatchObject({
        balance: -MEMES_MINT_PRICE
      });
      expect(verifyEntryMoney([entry])).toEqual([]);
    });

    it('fails when a balance changes with no charge, or the redeemed count disagrees', async () => {
      const entry = redemption(
        7,
        [{ transaction: MINT_TX, identity_key: P1, token_count: 1 }],
        { [P1]: 1, [P2]: 1 }
      );
      const redeemed = entry.changes.find((c) => c.table === 'redeemed')!;
      (redeemed.after as Row).count = 2;
      expect(verifyEntryMoney([entry])).toEqual([
        `n=7 redemption: the balance of ${P2} changes with no charge`,
        `n=7 redemption: the redeemed count of ${P1} for ${MINT_TX} moves by 2; it was charged 1 times`
      ]);
    });

    it('fails when a mint is charged more tokens than it delivered', async () => {
      const first = redemption(
        7,
        [
          { transaction: MINT_TX, identity_key: P1, token_count: 2 },
          { transaction: MINT_TX, identity_key: P2, token_count: 2 }
        ],
        { [P1]: 1, [P2]: 1 }
      );
      const again = redemption(
        8,
        [{ transaction: MINT_TX, identity_key: P1, token_count: 2 }],
        { [P1]: roundSubscriptionBalance(1 - MEMES_MINT_PRICE) }
      );
      const report = await verify([first, again]);
      expect(report.failures).toEqual([
        `mint ${MINT_KEY} delivered 2 tokens and is charged 3 times (journal n=7, 8)`
      ]);
    });

    it('counts the opening file charges of a mint the journal charges too', async () => {
      const entry = redemption(
        7,
        [{ transaction: MINT_TX, identity_key: P1, token_count: 2 }],
        { [P1]: 1 }
      );
      const opening = {
        topUps: [],
        redeemed: [
          {
            transaction: MINT_TX.toUpperCase().replace('0X', '0x'),
            contract: MEMES_CONTRACT,
            tokenId: 7,
            address: AIRDROP,
            count: 2
          } as never
        ]
      };
      expect((await verify([entry], { opening })).failures).toEqual([
        `mint ${MINT_KEY} delivered 2 tokens and is charged 3 times (journal n=7)`
      ]);
    });

    it('fails against Ethereum when the mint delivered another count', async () => {
      const entry = redemption(
        7,
        [{ transaction: MINT_TX, identity_key: P1, token_count: 3 }],
        { [P1]: 1 }
      );
      const report = await verify([entry], { ethereum: ethereumFixture() });
      expect(report.failures).toEqual([
        `mint ${MINT_KEY}: Ethereum shows 2 tokens minted; the charges say 3`
      ]);
    });
  });

  describe('a fold', () => {
    it('sums, unrounded, and passes when either side had no balance', async () => {
      expect(verifyEntryMoney([fold(4, 0.1, 0.2)])).toEqual([]);
      expect(verifyEntryMoney([fold(4, null, 0.2)])).toEqual([]);
      expect(verifyEntryMoney([fold(4, 0.1, null)])).toEqual([]);
      expect(verifyEntryMoney([fold(4, null, null)])).toEqual([]);
    });

    it('fails when the sum is wrong or the wallet keeps a balance', async () => {
      const entry = fold(4, 0.1, 0.2);
      (entry.changes[0].after as Row).balance = 0.3;
      (entry.changes[1] as { after: Row | null }).after = balanceRow(W2, 0);
      expect(verifyEntryMoney([entry])).toEqual([
        `n=4 fold: the fold leaves a balance on ${W2}`,
        `n=4 fold: the balance of ${P1} is 0.3 after folding 0.2 into 0.1; expected ${0.1 + 0.2}`
      ]);
    });

    it("fails when the wallet's balance leaves and the identity's stays", async () => {
      const entry = fold(4, 0.1, 0.2);
      entry.changes.splice(0, 1);
      expect(verifyEntryMoney([entry])).toEqual([
        `n=4 fold: 0.2 leaves ${W2} and the balance of ${P1} does not change`
      ]);
    });
  });

  it('fails when any other kind changes a balance', async () => {
    const [entry] = build(5);
    entry.changes.push(balance(P1, 1, 2));
    expect(verifyEntryMoney([entry])).toEqual([
      `n=5 build: a build entry changes the balance of ${P1}`
    ]);
    const report = await verify([entry]);
    expect(report.failures).toEqual([
      'n=5 build: a build entry changes balances',
      `n=5 build: a build entry changes the balance of ${P1}`
    ]);
  });

  describe('a choice', () => {
    it('fails when no verified record in lane subs has its event id', async () => {
      const report = await verify([choice(8, 'f'.repeat(32))], {
        events: eventsFixture({ [EVENT]: GOOD_EVENT })
      });
      expect(report.failures).toEqual([
        `n=8 choice: event ${'f'.repeat(32)} is not a verified record in lane subs`
      ]);
    });

    it('fails when the record has another type, key or owner, or no body', async () => {
      const report = await verify([choice(8)], {
        events: eventsFixture({
          [EVENT]: { type: 'subs.card', key: '', body: null, owner: P2 }
        })
      });
      expect(report.failures).toEqual([
        `n=8 choice: event ${EVENT} differs in type, owner`,
        `n=8 choice: event ${EVENT} has no body, so it is no choice`
      ]);
    });
  });

  describe('order and parts', () => {
    it('fails when a write misses a part, and checks no money in it', async () => {
      const [first] = build(5, 2);
      const report = await verify([topUp(1, 0.1, null), first]);
      expect(report.failures).toEqual([
        'n=5 build: parts 0 of 2 are in the journal'
      ]);
    });

    it('takes parts in any order, but not parts that disagree', async () => {
      const [a, b] = build(5, 2);
      expect((await verify([b, a])).failures).toEqual([]);
      const report = await verify([a, { ...b, at_ms: b.at_ms + 1 }]);
      expect(report.failures).toEqual([
        'n=5 build: its parts differ in kind, mode, time or inputs'
      ]);
    });

    it('fails when n does not increase in log order', async () => {
      const report = await verify([topUp(3, 0.2, null), topUp(1, 0.1, 0.2)]);
      expect(report.failures).toEqual([
        'n=1 top-up comes after n=3 in the log'
      ]);
    });

    it('fails when a kind changes a table it may not', async () => {
      const entry = body(9, 'phase', { contract: MEMES_CONTRACT }, [
        {
          table: 'top_up',
          key: { hash: hash(1) },
          before: null,
          after: { hash: hash(1) }
        }
      ]);
      expect((await verify([entry])).failures).toEqual([
        'n=9 phase: a phase entry changes top_up'
      ]);
    });
  });

  it('passes any run of top-ups and charges made with the legacy arithmetic, and fails it when one balance is off', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant('top-up' as const),
              amount: fc.integer({ min: 1, max: 2_000_000 }).map((x) => x / 1e6)
            }),
            fc.record({
              kind: fc.constant('charge' as const),
              tokens: fc.integer({ min: 1, max: 3 })
            })
          ),
          { minLength: 1, maxLength: 30 }
        ),
        fc.nat(),
        async (steps, pick) => {
          let current: number | null = null;
          const bodies: JournalBody[] = [];
          steps.forEach((step, i) => {
            const n = i + 1;
            if (step.kind === 'top-up') {
              bodies.push(topUp(n, step.amount, current));
              current =
                current === null
                  ? step.amount
                  : roundSubscriptionBalance(current + step.amount);
            } else {
              const charges = Array.from({ length: step.tokens }, () => ({
                transaction: hash(5000 + n),
                identity_key: P1,
                token_count: step.tokens
              }));
              const entry = redemption(n, charges, { [P1]: current });
              bodies.push(entry);
              current = Number((entry.changes[0].after as Row).balance);
            }
          });
          expect((await verify(bodies)).failures).toEqual([]);
          const target = bodies[pick % bodies.length];
          const change = target.changes[0];
          (change.after as Row).balance =
            Number((change.after as Row).balance) + 0.00001;
          expect((await verify(bodies)).failures).toHaveLength(1);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('ReplayedSubscriptionEvents', () => {
  const verified = (ok: boolean, id = EVENT): RecordVerifyResult =>
    ok
      ? ({
          ok: true,
          record: {
            event: { id },
            owner: P1,
            parsed: {
              kind: RecordKind.RECORD,
              type: 'subs.mode',
              key: '',
              body: { automatic: true }
            }
          }
        } as never)
      : { ok: false, reason: 'sig', detail: 'bad signature' };

  it('finds the records that verified, and only those', async () => {
    const events = new ReplayedSubscriptionEvents();
    events.add(verified(true));
    events.add(verified(false, 'f'.repeat(32)));
    expect(await events.find(EVENT)).toEqual(GOOD_EVENT);
    expect(await events.find('f'.repeat(32))).toBeNull();
  });
});
