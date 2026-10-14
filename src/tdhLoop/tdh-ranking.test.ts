import fc from 'fast-check';
import { MEMES_CONTRACT } from '@/constants';
import {
  compareCollectionTdh,
  compareOverallTdh,
  compareTokenOwners,
  compareTokenTdh,
  shouldIncludeWalletTdh
} from './tdh-ranking';
import { calculateRanks } from './tdh';

jest.mock('@/db', () => ({}));
jest.mock('@/nextgen/nextgen.db', () => ({}));

function row(key: string, consolidated = false) {
  return {
    ...(consolidated
      ? { consolidation_key: key, wallets: key.split('-') }
      : { wallet: key }),
    boosted_tdh: 100,
    tdh: 80,
    balance: 6,
    boosted_memes_tdh: 90,
    memes_tdh: 70,
    memes_balance: 4,
    boosted_gradients_tdh: 6,
    gradients_tdh: 5,
    gradients_balance: 1,
    boosted_nextgen_tdh: 4,
    nextgen_tdh: 3,
    nextgen_balance: 1,
    memes: [{ id: 1, tdh: 70 }],
    gradients: [],
    nextgen: [],
    memes_ranks: [],
    gradients_ranks: [],
    nextgen_ranks: []
  };
}

describe('deterministic TDH ranking', () => {
  it.each([false, true])(
    'assigns the same overall, collection and Meme token ranks after any input permutation (consolidated=%s)',
    async (consolidated) => {
      const keys = consolidated
        ? ['0xCc-0xdd', '0xAa-0xff', '0xbb-0xee']
        : ['0xCc', '0xAa', '0xbb'];
      await fc.assert(
        fc.asyncProperty(
          fc.shuffledSubarray(keys, {
            minLength: keys.length,
            maxLength: keys.length
          }),
          async (input) => {
            const ranked = await calculateRanks(
              [],
              [],
              input.map((key) => row(key, consolidated)),
              [{ contract: MEMES_CONTRACT, id: 1 }],
              []
            );
            const byKey = new Map(
              ranked.map((r) => [
                (r.consolidation_key ?? r.wallet).toLowerCase(),
                r
              ])
            );
            const expected = consolidated
              ? ['0xaa-0xff', '0xbb-0xee', '0xcc-0xdd']
              : ['0xaa', '0xbb', '0xcc'];
            expected.forEach((key, index) => {
              const r = byKey.get(key);
              expect(r.tdh_rank).toBe(index + 1);
              expect(r.tdh_rank_memes).toBe(index + 1);
              expect(r.tdh_rank_gradients).toBe(index + 1);
              expect(r.tdh_rank_nextgen).toBe(index + 1);
              expect(r.memes_ranks).toEqual([{ id: 1, rank: index + 1 }]);
              expect(r.boosted_tdh).toBe(100);
              expect(r.tdh).toBe(80);
              expect(r.balance).toBe(6);
            });
          }
        ),
        { numRuns: 12 }
      );
    }
  );

  it.each(['memes', 'gradients', 'nextgen'] as const)(
    'uses total balance in both directions before the address tie-break for %s',
    async (collection) => {
      const lower = { ...row('0xaa'), balance: 6 };
      const higher = { ...row('0xbb'), balance: 7 };
      expect(compareCollectionTdh(lower, higher, collection)).toBeGreaterThan(
        0
      );
      expect(compareCollectionTdh(higher, lower, collection)).toBeLessThan(0);
      const ranked = await calculateRanks([], [], [lower, higher], [], []);
      expect(
        ranked.find((r) => r.wallet === '0xbb')[`tdh_rank_${collection}`]
      ).toBe(1);
      expect(
        ranked.find((r) => r.wallet === '0xaa')[`tdh_rank_${collection}`]
      ).toBe(2);
    }
  );

  it('preserves score precedence and uses identity only for complete ties', () => {
    const a = row('0xaa');
    const b = row('0xbb');
    expect(compareOverallTdh(a, b)).toBeLessThan(0);
    expect(compareOverallTdh({ ...a, boosted_tdh: 99 }, b)).toBeGreaterThan(0);
    expect(compareOverallTdh({ ...a, tdh: 79 }, b)).toBeGreaterThan(0);
    expect(compareOverallTdh({ ...a, gradients_tdh: 4 }, b)).toBeGreaterThan(0);
    expect(compareOverallTdh({ ...a, nextgen_tdh: 2 }, b)).toBeGreaterThan(0);
    expect(compareTokenOwners(a, b, 69, 70)).toBeGreaterThan(0);
    expect(
      compareTokenOwners({ ...a, boosted_tdh: 99 }, b, 70, 70)
    ).toBeGreaterThan(0);
    expect(compareTokenOwners(a, b, 70, 70)).toBeLessThan(0);
  });

  it('returns zero on equal canonical identities and does not mutate fallback group members', () => {
    const a = row('0xAA');
    const b = row('0xaa');
    expect(compareOverallTdh(a, b)).toBe(0);
    expect(compareCollectionTdh(a, b, 'memes')).toBe(0);
    expect(compareTokenOwners(a, b, 70, 70)).toBe(0);
    const members = ['0xBB', '0xAA'];
    const fallback = { ...a, wallet: undefined, wallets: members };
    expect(compareOverallTdh(fallback, row('0xaa-0xbb', true))).toBe(0);
    expect(members).toEqual(['0xBB', '0xAA']);
  });

  it('orders NFT ties by numeric token ID and returns zero for the same numeric ID', () => {
    const tokens = [
      { id: '10', tdh: 70 },
      { id: 2, tdh: 70 },
      { id: 1, tdh: 69 }
    ];
    expect(tokens.sort(compareTokenTdh).map((t) => t.id)).toEqual([2, '10', 1]);
    expect(compareTokenTdh({ id: '2', tdh: 70 }, { id: 2, tdh: 70 })).toBe(0);
  });

  it.each<[number, number, number, boolean]>([
    [0, 0, 1, false],
    [0, 0, 0, false],
    [0, 1, 1, true],
    [0, 0, 2, true],
    [0, 0, 4, true],
    [1, 0, 1, true]
  ])(
    'retains exactly the existing wallet inclusion rule: TDH=%i, balance=%i, members=%i',
    (tdh, balance, members, included) => {
      expect(shouldIncludeWalletTdh(tdh, balance, members)).toBe(included);
    }
  );

  it('keeps collection-zero ranks excluded while retaining overall ranks for legitimate zero-score rows', async () => {
    const zero = {
      ...row('0xbb'),
      boosted_tdh: 0,
      tdh: 0,
      boosted_memes_tdh: 0,
      memes_tdh: 0,
      boosted_gradients_tdh: 0,
      gradients_tdh: 0,
      boosted_nextgen_tdh: 0,
      nextgen_tdh: 0,
      memes: []
    };
    const ranked = await calculateRanks([], [], [zero, row('0xaa')], [], []);
    const z = ranked.find((r) => r.wallet === '0xbb');
    expect(z.tdh_rank).toBe(2);
    expect(z.tdh_rank_memes).toBe(-1);
    expect(z.tdh_rank_gradients).toBe(-1);
    expect(z.tdh_rank_nextgen).toBe(-1);
  });

  it('replaces cached token ranks when reranking persisted rows', async () => {
    const rows = [row('0xbb'), row('0xaa')];
    await calculateRanks(
      [],
      [],
      rows,
      [{ contract: MEMES_CONTRACT, id: 1 }],
      []
    );
    await calculateRanks(
      [],
      [],
      rows,
      [{ contract: MEMES_CONTRACT, id: 1 }],
      []
    );
    expect(
      rows.find((r) => 'wallet' in r && r.wallet === '0xaa')?.memes_ranks
    ).toEqual([{ id: 1, rank: 1 }]);
    expect(
      rows.find((r) => 'wallet' in r && r.wallet === '0xbb')?.memes_ranks
    ).toEqual([{ id: 1, rank: 2 }]);
  });
});
