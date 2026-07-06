import fc from 'fast-check';
import {
  fetchConsolidationDisplay,
  fetchConsolidationDisplays,
  fetchLatestTDHBlockNumber,
  retrieveConsolidationsForWallets,
  retrieveWalletConsolidations
} from '@/db';
import { TDHENS } from '@/entities/ITDH';
import { equalIgnoreCase } from '@/strings';
import { createMemesData, getGenesisAndNaka } from './tdh';
import {
  consolidateCards,
  consolidateMissingWallets,
  consolidateTDHForWallets
} from './tdh_consolidation';

jest.mock('@/db', () => ({
  fetchAllConsolidatedTdh: jest.fn(),
  fetchAllTDH: jest.fn(),
  fetchConsolidationDisplay: jest.fn(),
  fetchConsolidationDisplays: jest.fn(),
  fetchLatestTDHBlockNumber: jest.fn(),
  persistConsolidatedTDH: jest.fn(),
  persistTDHBlock: jest.fn(),
  retrieveConsolidationsForWallets: jest.fn(),
  retrieveWalletConsolidations: jest.fn()
}));

jest.mock('@/nextgen/nextgen.db', () => ({
  fetchNextgenTokens: jest.fn()
}));

const mockedRetrieveConsolidationsForWallets =
  retrieveConsolidationsForWallets as jest.MockedFunction<
    typeof retrieveConsolidationsForWallets
  >;
const mockedFetchConsolidationDisplays =
  fetchConsolidationDisplays as jest.MockedFunction<
    typeof fetchConsolidationDisplays
  >;
const mockedRetrieveWalletConsolidations =
  retrieveWalletConsolidations as jest.MockedFunction<
    typeof retrieveWalletConsolidations
  >;
const mockedFetchConsolidationDisplay =
  fetchConsolidationDisplay as jest.MockedFunction<
    typeof fetchConsolidationDisplay
  >;
const mockedFetchLatestTDHBlockNumber =
  fetchLatestTDHBlockNumber as jest.MockedFunction<
    typeof fetchLatestTDHBlockNumber
  >;

const WALLET_POOL = [
  '0xAaA1',
  '0xbbb2',
  '0xCcC3',
  '0xddd4',
  '0xEee5',
  '0xfff6'
];

function buildConsolidationKey(wallets: string[]): string {
  return wallets
    .map((it) => it.toLowerCase())
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .join('-');
}

type TokenLike = {
  id: number;
  balance: number;
  tdh: number;
  tdh__raw: number;
  days_held_per_edition: number[];
};

function tokenArb(maxId: number): fc.Arbitrary<TokenLike> {
  return fc.record({
    id: fc.integer({ min: 1, max: maxId }),
    balance: fc.integer({ min: 1, max: 5 }),
    tdh: fc.integer({ min: 0, max: 1000 }),
    tdh__raw: fc.integer({ min: 0, max: 1000 }),
    days_held_per_edition: fc.array(fc.integer({ min: 0, max: 500 }), {
      maxLength: 3
    })
  });
}

function distinctByTokenId(tokens: TokenLike[]): TokenLike[] {
  const seen = new Set<number>();
  return tokens.filter((t) => {
    if (seen.has(t.id)) {
      return false;
    }
    seen.add(t.id);
    return true;
  });
}

const tdhEntryArb: fc.Arbitrary<TDHENS> = fc
  .record({
    walletIdx: fc.integer({ min: 0, max: WALLET_POOL.length - 1 }),
    block: fc.integer({ min: 1, max: 99 }),
    tdh: fc.integer({ min: 0, max: 100000 }),
    tdh__raw: fc.integer({ min: 0, max: 100000 }),
    balance: fc.integer({ min: 0, max: 100 }),
    memes_tdh: fc.integer({ min: 0, max: 1000 }),
    memes_tdh__raw: fc.integer({ min: 0, max: 1000 }),
    memes_balance: fc.integer({ min: 0, max: 100 }),
    gradients_tdh: fc.integer({ min: 0, max: 1000 }),
    gradients_tdh__raw: fc.integer({ min: 0, max: 1000 }),
    gradients_balance: fc.integer({ min: 0, max: 100 }),
    nextgen_tdh: fc.integer({ min: 0, max: 1000 }),
    nextgen_tdh__raw: fc.integer({ min: 0, max: 1000 }),
    nextgen_balance: fc.integer({ min: 0, max: 100 }),
    memes: fc.array(tokenArb(2), { maxLength: 3 }),
    gradients: fc.array(tokenArb(4), { maxLength: 2 }),
    nextgen: fc.array(tokenArb(4), { maxLength: 2 })
  })
  .map(
    (r) =>
      ({
        wallet: WALLET_POOL[r.walletIdx],
        ensName: '',
        block: r.block,
        tdh: r.tdh,
        tdh__raw: r.tdh__raw,
        balance: r.balance,
        memes_tdh: r.memes_tdh,
        memes_tdh__raw: r.memes_tdh__raw,
        memes_balance: r.memes_balance,
        gradients_tdh: r.gradients_tdh,
        gradients_tdh__raw: r.gradients_tdh__raw,
        gradients_balance: r.gradients_balance,
        nextgen_tdh: r.nextgen_tdh,
        nextgen_tdh__raw: r.nextgen_tdh__raw,
        nextgen_balance: r.nextgen_balance,
        memes: distinctByTokenId(r.memes),
        gradients: distinctByTokenId(r.gradients),
        nextgen: distinctByTokenId(r.nextgen)
      }) as unknown as TDHENS
  );

/**
 * Random partition of the wallet pool into consolidation clusters of size 1-3.
 * Returns wallet (lowercase) -> consolidation key.
 */
const partitionArb: fc.Arbitrary<Record<string, string>> = fc
  .array(fc.integer({ min: 0, max: 2 }), {
    minLength: WALLET_POOL.length,
    maxLength: WALLET_POOL.length
  })
  .map((sizes) => {
    const remaining = [...WALLET_POOL];
    const mapping: Record<string, string> = {};
    let i = 0;
    while (remaining.length) {
      const size = Math.min(sizes[i % sizes.length] + 1, remaining.length);
      i++;
      const cluster = remaining.splice(0, size);
      const key = buildConsolidationKey(cluster);
      cluster.forEach((w) => {
        mapping[w.toLowerCase()] = key;
      });
    }
    return mapping;
  });

/**
 * Reference implementation: the exact pre-optimization algorithm of
 * consolidateTDHForWallets (quadratic scans included), kept here to prove the
 * optimized version produces identical output.
 */
function referenceConsolidateTDHForWallets(
  tdh: TDHENS[],
  MEMES_COUNT: number,
  walletToKey: Record<string, string>,
  displays: Record<string, string>
) {
  const consolidatedTdh: any[] = [];
  const processedWallets = new Set<string>();
  const allGradientsTDH: any[] = [];
  const allNextgenTDH: any[] = [];

  for (const tdhEntry of tdh) {
    const wallet = tdhEntry.wallet;
    const consolidationKey = walletToKey[wallet.toLowerCase()];
    const display = displays[consolidationKey];
    const consolidations = consolidationKey.split('-');

    if (
      !Array.from(processedWallets).some((pw) => equalIgnoreCase(wallet, pw))
    ) {
      const consolidatedWalletsTdh = [...tdh].filter((t) =>
        consolidations.some((c) => equalIgnoreCase(c, t.wallet))
      );

      let totalTDH = 0;
      let totalTDH__raw = 0;
      let totalBalance = 0;
      const memesData = createMemesData();
      let gradientsTDH = 0;
      let gradientsTDH__raw = 0;
      let gradientsBalance = 0;
      let nextgenTDH = 0;
      let nextgenTDH__raw = 0;
      let nextgenBalance = 0;
      let consolidationMemes: any[] = [];
      let consolidationGradients: any[] = [];
      let consolidationNextgen: any[] = [];

      consolidatedWalletsTdh.forEach((wTdh) => {
        totalTDH += wTdh.tdh;
        totalTDH__raw += wTdh.tdh__raw;
        totalBalance += wTdh.balance;
        memesData.memes_tdh += wTdh.memes_tdh;
        memesData.memes_tdh__raw += wTdh.memes_tdh__raw;
        memesData.memes_balance += wTdh.memes_balance;
        gradientsTDH += wTdh.gradients_tdh;
        gradientsTDH__raw += wTdh.gradients_tdh__raw;
        gradientsBalance += wTdh.gradients_balance;
        nextgenTDH += wTdh.nextgen_tdh;
        nextgenTDH__raw += wTdh.nextgen_tdh__raw;
        nextgenBalance += wTdh.nextgen_balance;
        consolidationMemes = consolidateCards(consolidationMemes, wTdh.memes);
        consolidationGradients = consolidateCards(
          consolidationGradients,
          wTdh.gradients
        );
        consolidationNextgen = consolidateCards(
          consolidationNextgen,
          wTdh.nextgen
        );
      });

      let memesCardSets = 0;
      if (consolidationMemes.length == MEMES_COUNT) {
        memesCardSets = Math.min(
          ...consolidationMemes.map((o: any) => o.balance)
        );
      }
      const genNaka = getGenesisAndNaka(consolidationMemes);

      consolidatedTdh.push({
        consolidation_display: display,
        consolidation_key: consolidationKey,
        wallets: consolidations,
        tdh_rank: 0,
        tdh_rank_memes: 0,
        tdh_rank_gradients: 0,
        tdh_rank_nextgen: 0,
        block: tdhEntry.block,
        tdh: totalTDH,
        boost: 0,
        boosted_tdh: 0,
        tdh__raw: totalTDH__raw,
        balance: totalBalance,
        memes_cards_sets: memesCardSets,
        genesis: genNaka.genesis,
        nakamoto: genNaka.naka,
        unique_memes: consolidationMemes.length,
        memes_tdh: memesData.memes_tdh,
        memes_tdh__raw: memesData.memes_tdh__raw,
        memes_balance: memesData.memes_balance,
        boosted_memes_tdh: memesData.boosted_memes_tdh,
        memes_ranks: memesData.memes_ranks,
        memes: consolidationMemes,
        boosted_gradients_tdh: 0,
        gradients_tdh: gradientsTDH,
        gradients_tdh__raw: gradientsTDH__raw,
        gradients_balance: gradientsBalance,
        gradients: consolidationGradients,
        gradients_ranks: [],
        boosted_nextgen_tdh: 0,
        nextgen_tdh: nextgenTDH,
        nextgen_tdh__raw: nextgenTDH__raw,
        nextgen_balance: nextgenBalance,
        nextgen: consolidationNextgen,
        nextgen_ranks: [],
        boost_breakdown: {},
        boosted_tdh_rate: 0
      });
      consolidationGradients.forEach((wg) => allGradientsTDH.push(wg));
      consolidationNextgen.forEach((wn) => allNextgenTDH.push(wn));
    }
    consolidations.forEach((c) => {
      processedWallets.add(c);
    });
  }

  return { consolidatedTdh, allGradientsTDH, allNextgenTDH };
}

function stripDates(consolidations: any[]): any[] {
  return consolidations.map((c) => {
    const { date, ...rest } = c;
    expect(date).toBeInstanceOf(Date);
    return rest;
  });
}

describe('consolidateTDHForWallets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('produces exactly the same output as the pre-optimization reference implementation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tdhEntryArb, { maxLength: 12 }),
        partitionArb,
        fc.integer({ min: 1, max: 3 }),
        async (tdh, walletToKey, memesCount) => {
          const displays = Object.values(walletToKey).reduce(
            (acc, key) => {
              acc[key] = `display:${key}`;
              return acc;
            },
            {} as Record<string, string>
          );
          mockedRetrieveConsolidationsForWallets.mockResolvedValue(walletToKey);
          mockedFetchConsolidationDisplays.mockResolvedValue(displays);

          const actual = await consolidateTDHForWallets(
            structuredClone(tdh),
            memesCount
          );
          const expected = referenceConsolidateTDHForWallets(
            structuredClone(tdh),
            memesCount,
            walletToKey,
            displays
          );

          expect(stripDates(actual.consolidatedTdh)).toEqual(
            expected.consolidatedTdh
          );
          expect(actual.allGradientsTDH).toEqual(expected.allGradientsTDH);
          expect(actual.allNextgenTDH).toEqual(expected.allNextgenTDH);
        }
      ),
      { numRuns: 50 }
    );
  });
});

describe('consolidateMissingWallets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchLatestTDHBlockNumber.mockResolvedValue(77);
    mockedRetrieveWalletConsolidations.mockImplementation(async (wallet) => {
      const key = buildConsolidationKey(['0xAaA1', '0xbbb2']);
      if (key.split('-').some((w) => equalIgnoreCase(w, wallet))) {
        return key.split('-');
      }
      return [wallet];
    });
    mockedFetchConsolidationDisplay.mockImplementation(
      async (wallets) => `display:${buildConsolidationKey(wallets)}`
    );
  });

  it('emits one entry per consolidation and dedupes case-insensitively', async () => {
    const result = await consolidateMissingWallets([
      '0xaaa1',
      '0xBBB2',
      '0xAAA1',
      '0xccc3'
    ]);

    expect(result.map((r) => r.consolidation_key)).toEqual([
      buildConsolidationKey(['0xAaA1', '0xbbb2']),
      '0xccc3'
    ]);
    expect(result.every((r) => r.block === 77)).toBe(true);
  });

  it('does not hit the database for wallets already covered by an earlier consolidation', async () => {
    await consolidateMissingWallets(['0xaaa1', '0xBBB2', '0xAAA1']);

    expect(mockedRetrieveWalletConsolidations).toHaveBeenCalledTimes(1);
    expect(mockedFetchConsolidationDisplay).toHaveBeenCalledTimes(1);
  });
});
