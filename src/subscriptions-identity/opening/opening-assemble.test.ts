import { MEMES_CONTRACT } from '@/constants';
import { assembleOpening } from './opening-assemble';
import { LegacyTables, walletsInTables } from './legacy-tables';
import { parseOpeningFiles } from './opening-load';

jest.mock('@/sql-executor', () => ({ sqlExecutor: {} }));

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const principal = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const P1 = principal(1);
const P2 = principal(2);
const A = wallet(1);
const B = wallet(2);
const C = wallet(3);
const LONE = wallet(4);
const DELEGATE = wallet(5);
const PAIR = `${A}-${B}`;
const OLD_SPLIT = `${A}-${C}`;
const T = '2026-11-20 10:00:00.123456';
const NOV_21 = '2026-11-21 11:00:00.000000';
const MAX = 579;

const byWallet = new Map([
  [A, P1],
  [B, P1],
  [C, P2]
]);

function tables(): LegacyTables {
  return {
    balances: [
      {
        consolidation_key: PAIR,
        balance: 0.13058,
        created_at: T,
        updated_at: NOV_21
      },
      {
        consolidation_key: LONE,
        balance: 0.06529,
        created_at: T,
        updated_at: T
      }
    ],
    modes: [
      {
        consolidation_key: PAIR,
        automatic: 1,
        subscribe_all_editions: 0,
        created_at: T,
        updated_at: NOV_21
      }
    ],
    choices: [
      {
        consolidation_key: PAIR,
        contract: MEMES_CONTRACT,
        token_id: MAX + 1,
        subscribed: 1,
        subscribed_count: 1,
        automatic_subscription: 0,
        created_at: T,
        updated_at: NOV_21
      },
      {
        consolidation_key: OLD_SPLIT,
        contract: MEMES_CONTRACT,
        token_id: '300',
        subscribed: 1,
        subscribed_count: 2,
        automatic_subscription: 1,
        created_at: T,
        updated_at: T
      }
    ],
    topUps: [
      {
        hash: '0xb',
        block: 20,
        transaction_date: NOV_21,
        from_wallet: B,
        amount: 0.1,
        created_at: NOV_21
      },
      {
        hash: '0xa',
        block: 10,
        transaction_date: T,
        from_wallet: LONE,
        amount: 0.06529,
        created_at: T
      }
    ],
    finalRows: [
      {
        id: 41,
        consolidation_key: OLD_SPLIT,
        contract: MEMES_CONTRACT,
        token_id: 300,
        subscribed_count: 1,
        airdrop_address: C,
        balance: 1,
        subscribed_at: '2025-01-01',
        phase: 'Phase 1',
        phase_subscriptions: 1,
        phase_position: 3,
        redeemed_count: 1,
        created_at: T,
        updated_at: T
      },
      {
        id: 7,
        consolidation_key: PAIR,
        contract: MEMES_CONTRACT,
        token_id: MAX + 1,
        subscribed_count: 1,
        airdrop_address: DELEGATE,
        balance: 0.13058,
        subscribed_at: NOV_21,
        phase: null,
        phase_subscriptions: -1,
        phase_position: -1,
        redeemed_count: 0,
        created_at: NOV_21,
        updated_at: NOV_21
      }
    ],
    uploads: [
      {
        contract: MEMES_CONTRACT,
        token_id: MAX + 1,
        date: '2026-11-25',
        upload_url: 'https://example.test/list.csv',
        created_at: NOV_21
      }
    ],
    redeemed: [
      {
        consolidation_key: OLD_SPLIT,
        contract: MEMES_CONTRACT,
        token_id: 300,
        address: C,
        transaction: '0xt',
        transaction_date: T,
        value: 0.06529,
        balance_after: 0.9,
        count: 1,
        created_at: T
      }
    ],
    logs: [
      {
        id: 7,
        consolidation_key: OLD_SPLIT,
        log: 'Subscribed',
        additional_info: null,
        created_at: T
      },
      {
        id: 3,
        consolidation_key: LONE,
        log: 'Top up',
        additional_info: 'x',
        created_at: T
      }
    ],
    queue: []
  };
}

const cut = {
  at: '2026-11-26T12:00:00.000Z',
  maxMemeId: MAX,
  topUpBlock: 30,
  redemptionBlock: 40,
  mintPrice: 0.06529
};

function shuffled(t: LegacyTables): LegacyTables {
  const rev = <T>(rows: T[]) => [...rows].reverse();
  return {
    balances: rev(t.balances),
    modes: rev(t.modes),
    choices: rev(t.choices),
    topUps: rev(t.topUps),
    finalRows: rev(t.finalRows),
    uploads: rev(t.uploads),
    redeemed: rev(t.redeemed),
    logs: rev(t.logs),
    queue: rev(t.queue)
  };
}

describe('assembleOpening', () => {
  const files = assembleOpening(cut, tables(), byWallet);

  it('gives the same bytes for the same tables in any row order', () => {
    const again = assembleOpening(cut, shuffled(tables()), byWallet);
    expect(again.openingBytes).toBe(files.openingBytes);
    expect(again.historyBytes).toBe(files.historyBytes);
    expect(again.openingSha256).toBe(files.openingSha256);
  });

  it('links the history by hash and parses back canonically', () => {
    const parsed = parseOpeningFiles(files.openingBytes, files.historyBytes);
    expect(parsed.opening.historySha256).toBe(files.historySha256);
    expect(() =>
      parseOpeningFiles(files.openingBytes, files.historyBytes + ' ')
    ).toThrow();
  });

  it('moves current state to identities and keeps dates as the database wrote them', () => {
    const o = files.opening;
    expect(o.blocked).toEqual([]);
    // Sorted by identity key, in code-unit order.
    expect(o.balances).toEqual([
      { identityKey: P1, balance: 0.13058, createdAt: T, updatedAt: NOV_21 },
      { identityKey: LONE, balance: 0.06529, createdAt: T, updatedAt: T }
    ]);
    expect(o.modes[0]).toEqual({
      identityKey: P1,
      automatic: true,
      subscribeAllEditions: false,
      createdAt: T,
      updatedAt: NOV_21
    });
    expect(o.choices.map((c) => [c.identityKey, c.tokenId])).toEqual([
      [P1, MAX + 1]
    ]);
    // The open card's final row follows its key, not its delegated address.
    expect(o.finalRows.find((f) => f.tokenId === MAX + 1)?.identityKey).toBe(
      P1
    );
  });

  it('attributes history: top-ups by sender, split rows by airdrop address, logs to every identity', () => {
    const o = files.opening;
    expect(o.topUps.map((t) => [t.hash, t.identityKey])).toEqual([
      ['0xa', LONE],
      ['0xb', P1]
    ]);
    expect(o.finalRows.find((f) => f.tokenId === 300)?.identityKey).toBe(P2);
    expect(o.redeemed[0].identityKey).toBe(P2);
    expect(o.attribution.map((n) => [n.table, n.rule])).toEqual([
      ['subscriptions_nfts_final', 'AIRDROP_ADDRESS'],
      ['subscriptions_redeemed', 'AIRDROP_ADDRESS']
    ]);
    expect(files.history.logs.map((l) => [l.legacyId, l.identityKey])).toEqual([
      [3, LONE],
      [7, P1],
      [7, P2]
    ]);
    expect(files.history.pastChoices.map((c) => c.tokenId)).toEqual([300]);
  });

  it('states exact totals', () => {
    expect(files.opening.totals).toEqual({
      keys: 3,
      identities: 2,
      balances: 2,
      modes: 1,
      choices: 1,
      topUps: 2,
      finalRows: 2,
      uploads: 1,
      redeemedRows: 1,
      balanceSum: '0.19587',
      topUpSum: '0.16529',
      redeemedCount: 1,
      redeemedValueSum: '0.06529'
    });
  });

  it('blocks a key with current state that spans identities', () => {
    const t = tables();
    const blocked = assembleOpening(
      cut,
      {
        ...t,
        balances: [
          ...t.balances,
          {
            consolidation_key: OLD_SPLIT,
            balance: 1,
            created_at: T,
            updated_at: T
          }
        ]
      },
      byWallet
    );
    expect(blocked.opening.blocked).toEqual([
      {
        consolidationKey: OLD_SPLIT,
        reason: 'SPANS_IDENTITIES',
        identities: [P1, P2]
      }
    ]);
  });

  it('names every wallet the tables mention', () => {
    expect(walletsInTables(tables())).toEqual([A, B, C, LONE, DELEGATE]);
  });
});
