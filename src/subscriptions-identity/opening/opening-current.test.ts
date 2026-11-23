import { MEMES_CONTRACT } from '@/constants';
import { LegacyTables, QueueRow } from './legacy-tables';
import { currentState } from './opening-current';

jest.mock('@/sql-executor', () => ({ sqlExecutor: {} }));

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const P1 = `0x${'1'.padStart(64, '0')}`;
const A = wallet(1);
const B = wallet(2);
const C = wallet(3);
const X = wallet(9);
const PAIR = `${A}-${B}`;
const WIDE = Array.from({ length: 14 }, (_, i) => wallet(0x40 + i)).join('-');
const NOV_20 = '2026-11-20 10:00:00.123456';
const NOV_21 = '2026-11-21 11:00:00.000000';
const CUT = { at: '2026-11-26T12:00:00.000Z', maxMemeId: 579 };
const CUT_TEXT = '2026-11-26 12:00:00.000000';

// A, B and C are one identity now; C's own key still holds state, as when
// the re-key was held back. The first wallet of WIDE is bound to P1 too.
const byWallet = new Map([
  [A, P1],
  [B, P1],
  [C, P1],
  [wallet(0x40), P1]
]);

function empty(): LegacyTables {
  return {
    balances: [],
    modes: [],
    choices: [],
    topUps: [],
    finalRows: [],
    uploads: [],
    redeemed: [],
    logs: [],
    queue: []
  };
}

function choice(
  key: string,
  subscribed: boolean,
  automatic: boolean,
  count: number,
  updatedAt: string
) {
  return {
    consolidation_key: key,
    contract: MEMES_CONTRACT,
    token_id: 580,
    subscribed: subscribed ? 1 : 0,
    subscribed_count: count,
    automatic_subscription: automatic ? 1 : 0,
    created_at: NOV_20,
    updated_at: updatedAt
  };
}

let sequence = 0;
function queued(kind: string, key: string, payload: unknown): QueueRow {
  sequence++;
  return {
    sequence,
    kind,
    consolidation_key: key,
    payload: JSON.stringify(payload),
    created_at: Date.parse('2026-11-25T08:00:00Z')
  };
}

function topUp(hash: string, from: string, amount: number) {
  return {
    topUp: {
      hash,
      block: 100,
      transaction_date: '2026-11-25T09:30:00.000Z',
      from_wallet: from,
      amount
    }
  };
}

describe('currentState', () => {
  it('merges the keys of one identity by the legacy rules', () => {
    const t = empty();
    t.balances.push(
      {
        consolidation_key: PAIR,
        balance: 0.25,
        created_at: NOV_20,
        updated_at: NOV_20
      },
      {
        consolidation_key: C,
        balance: 0.5,
        created_at: NOV_20,
        updated_at: NOV_21
      }
    );
    t.modes.push(
      {
        consolidation_key: PAIR,
        automatic: 0,
        subscribe_all_editions: 1,
        created_at: NOV_20,
        updated_at: NOV_20
      },
      {
        consolidation_key: C,
        automatic: 1,
        subscribe_all_editions: 0,
        created_at: NOV_20,
        updated_at: NOV_20
      }
    );
    t.choices.push(
      choice(PAIR, true, false, 2, NOV_21),
      choice(C, true, true, 1, NOV_20)
    );
    const state = currentState(CUT, t, byWallet);
    expect(state.blocked).toEqual([]);
    expect(state.merged).toEqual([
      { identityKey: P1, consolidationKeys: [PAIR, C].sort() }
    ]);
    expect(state.balances).toEqual([
      {
        identityKey: P1,
        balance: 0.75,
        createdAt: CUT_TEXT,
        updatedAt: CUT_TEXT
      }
    ]);
    // A fresh mode row: automatic and all editions if any key had them.
    expect(state.modes).toEqual([
      {
        identityKey: P1,
        automatic: true,
        subscribeAllEditions: true,
        createdAt: CUT_TEXT,
        updatedAt: CUT_TEXT
      }
    ]);
    // The manual request sets the count; the earlier priority time is kept.
    expect(state.choices).toEqual([
      {
        identityKey: P1,
        contract: MEMES_CONTRACT,
        tokenId: 580,
        subscribed: true,
        subscribedCount: 2,
        automaticSubscription: false,
        createdAt: NOV_20,
        updatedAt: NOV_20
      }
    ]);
  });

  it('leaves a single key untouched, times included', () => {
    const t = empty();
    t.balances.push({
      consolidation_key: PAIR,
      balance: 0.1,
      created_at: NOV_20,
      updated_at: NOV_21
    });
    t.choices.push(choice(PAIR, false, false, 1, NOV_21));
    const state = currentState(CUT, t, byWallet);
    expect(state.merged).toEqual([]);
    expect(state.balances[0]).toEqual({
      identityKey: P1,
      balance: 0.1,
      createdAt: NOV_20,
      updatedAt: NOV_21
    });
    expect(state.choices[0].updatedAt).toBe(NOV_21);
  });

  it("credits waiting top-ups to the sender's identity with the legacy arithmetic", () => {
    const t = empty();
    t.balances.push({
      consolidation_key: PAIR,
      balance: 0.1,
      created_at: NOV_20,
      updated_at: NOV_20
    });
    t.topUps.push({
      hash: '0xdone',
      block: 90,
      transaction_date: NOV_20,
      from_wallet: X,
      amount: 1,
      created_at: NOV_20
    });
    t.queue.push(
      // X's first top-up: unrounded, and it covers a card.
      queued('TOP_UP', X, topUp('0xa1', X, 0.07)),
      queued('TOP_UP', X, topUp('0xa2', X, 0.000006)),
      // Already credited by the top-up loop.
      queued('TOP_UP', X, topUp('0xdone', X, 1)),
      // Queued under a 14-wallet key; the sender is now in P1 and the
      // key's other wallets are not.
      queued('TOP_UP', WIDE, topUp('0xa3', wallet(0x40), 0.033333))
    );
    const state = currentState(CUT, t, byWallet);
    expect(state.balances).toEqual([
      {
        identityKey: P1,
        balance: 0.13333,
        createdAt: NOV_20,
        updatedAt: CUT_TEXT
      },
      {
        identityKey: X,
        balance: 0.07001,
        createdAt: CUT_TEXT,
        updatedAt: CUT_TEXT
      }
    ]);
    expect(state.modes).toEqual([
      {
        identityKey: X,
        automatic: true,
        subscribeAllEditions: false,
        createdAt: CUT_TEXT,
        updatedAt: CUT_TEXT
      }
    ]);
    expect(state.creditedTopUps.map((c) => [c.hash, c.identityKey])).toEqual([
      ['0xa1', X],
      ['0xa2', X],
      ['0xa3', P1]
    ]);
    expect(state.creditedTopUps[0].transactionDate).toBe(
      '2026-11-25 09:30:00.000000'
    );
    expect(state.queued.map((q) => q.effect)).toEqual([
      'TOP_UP_CREDITED',
      'TOP_UP_CREDITED',
      'TOP_UP_ALREADY_CREDITED',
      'TOP_UP_CREDITED'
    ]);
    // X's key goes to X. WIDE's wallets now span identities, so its key
    // blocks the cut as a legacy key's would; the credit is the same.
    expect(state.identityOf(X)).toBe(X);
    expect(
      state.blocked.map((b) => [
        b.consolidationKey,
        b.reason,
        b.identities.length
      ])
    ).toEqual([[WIDE, 'SPANS_IDENTITIES', 14]]);
  });

  it("keys a credited waiting top-up's key to its one identity, or to the identity a waiting re-key chose", () => {
    const wideWallets = WIDE.split('-');
    const oneIdentity = new Map(wideWallets.map((w) => [w, P1]));
    const t = empty();
    t.queue.push(queued('TOP_UP', WIDE, topUp('0xc1', wideWallets[0], 0.1)));
    const whole = currentState(CUT, t, oneIdentity);
    expect(whole.blocked).toEqual([]);
    expect(whole.identityOf(WIDE)).toBe(P1);

    // WIDE spans identities, but the legacy re-key the guard held back
    // chose Z's key for it. Z sorts after every identity of WIDE, so the
    // key follows the decision, not the sort order.
    const Z = `0x${'f'.repeat(64)}`;
    const Z_WALLET = wallet(0x99);
    t.queue.push(
      queued('CONSOLIDATION', Z_WALLET, { newKey: Z_WALLET, oldKeys: [WIDE] })
    );
    const decided = currentState(
      CUT,
      t,
      new Map([...Array.from(byWallet.entries()), [Z_WALLET, Z]])
    );
    expect(decided.blocked).toEqual([]);
    expect(decided.identityOf(WIDE)).toBe(Z);
  });

  it('subscribes the open cards again on a waiting first top-up, as the legacy mode change does', () => {
    const t = empty();
    // X unsubscribed from Meme #580 with no balance, then its first top-up
    // waited in the queue.
    t.choices.push(choice(X, false, false, 1, NOV_21));
    t.queue.push(queued('TOP_UP', X, topUp('0xb1', X, 0.07)));
    const state = currentState(CUT, t, byWallet);
    expect(
      state.choices.map((c) => [
        c.identityKey,
        c.tokenId,
        c.subscribed,
        c.updatedAt
      ])
    ).toEqual([[X, 580, true, '2026-11-25 09:30:00.000000']]);
    expect(state.queuedLogs.map((l) => [l.identityKey, l.log])).toEqual([
      [X, 'Subscription Mode set to Automatic'],
      [X, 'Subscribed to Meme #580']
    ]);
  });

  it('applies a queued re-key that splits a key, instead of blocking the cut', () => {
    const t = empty();
    // OLD's wallets now belong to P1 (A) and X: a split. The legacy re-key
    // chose P1's key for it, but the key-width guard held that back.
    const OLD = `${A}-${X}`;
    t.balances.push({
      consolidation_key: OLD,
      balance: 0.3,
      created_at: NOV_20,
      updated_at: NOV_20
    });
    t.queue.push(
      queued('CONSOLIDATION', PAIR, { newKey: PAIR, oldKeys: [OLD] })
    );
    const state = currentState(CUT, t, byWallet);
    expect(state.blocked).toEqual([]);
    expect(state.balances.map((b) => [b.identityKey, b.balance])).toEqual([
      [P1, 0.3]
    ]);
    expect(state.queued.map((q) => q.effect)).toEqual(['SPLIT_APPLIED_AT_CUT']);
  });

  it('blocks a split with no queued decision, and names a re-key with nothing left to do', () => {
    const t = empty();
    t.balances.push({
      consolidation_key: `${A}-${X}`,
      balance: 0.3,
      created_at: NOV_20,
      updated_at: NOV_20
    });
    t.queue.push(
      queued('CONSOLIDATION', PAIR, { newKey: PAIR, oldKeys: [PAIR] })
    );
    const state = currentState(CUT, t, byWallet);
    expect(state.blocked.map((b) => b.reason)).toEqual(['SPANS_IDENTITIES']);
    expect(state.queued.map((q) => q.effect)).toEqual(['NOTHING_TO_APPLY']);
  });

  it('carries waiting log lines, leaves list rows to the build, and blocks on a waiting redemption', () => {
    const t = empty();
    t.queue.push(
      queued('LOG', WIDE, {
        consolidation_key: WIDE,
        log: 'Top up',
        additional_info: 'x'
      }),
      queued('FINAL_ROW', WIDE, {}),
      queued('AUTO_SUBSCRIPTION', WIDE, {}),
      queued('CONSOLIDATION', WIDE, { newKey: WIDE, oldKeys: [WIDE] }),
      queued('REDEMPTION', PAIR, {}),
      queued('REDEMPTION', PAIR, {})
    );
    const state = currentState(CUT, t, byWallet);
    expect(state.queuedLogs).toEqual(
      // WIDE's wallets are P1 and thirteen unbound wallets: a copy each.
      expect.arrayContaining([
        expect.objectContaining({
          legacyId: null,
          identityKey: P1,
          log: 'Top up',
          additionalInfo: 'x',
          createdAt: '2026-11-25 08:00:00.000000'
        })
      ])
    );
    expect(state.queuedLogs).toHaveLength(14);
    expect(state.queued.map((q) => q.effect)).toEqual([
      'LOG_CARRIED',
      'LEFT_TO_THE_BUILD',
      'LEFT_TO_THE_BUILD',
      'NOTHING_TO_APPLY',
      'BLOCKS_THE_CUT',
      'BLOCKS_THE_CUT'
    ]);
    expect(state.blocked).toEqual([
      {
        consolidationKey: PAIR,
        reason: 'PENDING_REDEMPTION',
        identities: [P1]
      }
    ]);
  });
});
