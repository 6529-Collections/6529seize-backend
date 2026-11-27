import { MEMES_CONTRACT } from '@/constants';
import {
  applyKnownPhases,
  assignPublicPhase,
  orderBySubscribedAt,
  PhasedFinalRow,
  phaseAirdrops,
  splitPhase,
  toPhasedRow
} from './phase-split';

const W1 = '0x0000000000000000000000000000000000000001';
const W2 = '0x0000000000000000000000000000000000000002';
const W3 = '0x0000000000000000000000000000000000000003';
const W4 = '0x0000000000000000000000000000000000000004';
const A1 = '0x00000000000000000000000000000000000000a1';
const A2 = '0x00000000000000000000000000000000000000a2';
const MINTER = '0x00000000000000000000000000000000000000b1';

function row(
  key: string,
  subscribedAt: string,
  count: number,
  airdrop: string
): PhasedFinalRow {
  return toPhasedRow({
    key,
    contract: MEMES_CONTRACT,
    tokenId: 500,
    subscribedCount: count,
    airdropAddress: airdrop,
    balance: 1,
    subscribedAt
  });
}

const ROWS = [
  row(`${W1}-${W2}`, '2026-10-02T00:00:00.000Z', 2, A1),
  row(W3, '2026-10-01T00:00:00.000Z', 1, A2),
  row(W4, '2026-10-03T00:00:00.000Z', 3, A1)
];

describe('phase split', () => {
  it('orders rows by subscribed_at and keeps the input order on ties', () => {
    const tied = [
      row(W4, '2026-10-01T00:00:00.000Z', 1, A1),
      row(W3, '2026-10-01T00:00:00.000Z', 1, A2)
    ];
    expect(orderBySubscribedAt(tied).map((r) => r.key)).toEqual([W4, W3]);
  });

  it('takes rows whose key holds a result wallet, first pull wins', () => {
    const first = splitPhase({
      rows: ROWS,
      phaseName: 'Phase 0',
      results: [
        { wallet: W2, amount: 3 },
        { wallet: W3, amount: 1 }
      ],
      mintingDelegateOf: (wallet) => (wallet === W2 ? MINTER : undefined)
    });
    expect(first.airdropsUnconsolidated).toEqual([
      { wallet: A2, amount: 1 },
      { wallet: A1, amount: 2 }
    ]);
    expect(first.allowlists).toEqual([{ wallet: MINTER, amount: 2 }]);
    const phased = first.rows.filter((r) => r.phase === 'Phase 0');
    expect(
      phased.map((r) => [r.key, r.phasePosition, r.phaseSubscriptions])
    ).toEqual([
      [`${W1}-${W2}`, 2, 2],
      [W3, 1, 2]
    ]);

    const second = splitPhase({
      rows: first.rows,
      phaseName: 'Phase 1',
      results: [
        { wallet: W3, amount: 1 },
        { wallet: W4, amount: 1 }
      ]
    });
    expect(second.airdropsUnconsolidated).toEqual([{ wallet: A1, amount: 3 }]);
    expect(second.allowlists).toEqual([{ wallet: W3, amount: 1 }]);
  });

  it('refuses a result list with a wallet twice', () => {
    expect(() =>
      splitPhase({
        rows: ROWS,
        phaseName: 'Phase 0',
        results: [
          { wallet: W2, amount: 1 },
          { wallet: W2.toUpperCase().replace('0X', '0x'), amount: 1 }
        ]
      })
    ).toThrow('duplicates');
  });

  it('gives the public phase one card per row and merges addresses', () => {
    const result = assignPublicPhase(ROWS);
    expect(result.airdrops).toEqual([
      { wallet: A2, amount: 1 },
      { wallet: A1, amount: 2 }
    ]);
    expect(result.rows.every((r) => r.phase === 'Public')).toBe(true);
  });

  it('applies known phases in legacy order and lists their airdrops', () => {
    const rows = applyKnownPhases(
      ROWS,
      new Map([
        [W4, 'Phase 1'],
        [`${W1}-${W2}`, 'Phase 1'],
        [W3, 'Public']
      ])
    );
    expect(phaseAirdrops(rows, 'Phase 1')).toEqual({
      airdrops: [{ wallet: A1, amount: 5 }],
      airdropsUnconsolidated: [
        { wallet: A1, amount: 2 },
        { wallet: A1, amount: 3 }
      ]
    });
    expect(phaseAirdrops(rows, 'Public').airdrops).toEqual([
      { wallet: A2, amount: 1 }
    ]);
  });
});
