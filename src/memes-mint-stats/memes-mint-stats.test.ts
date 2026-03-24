import { MEMES_MINT_PRICE } from '@/constants';
import { calculateMemesMintStats } from '@/memes-mint-stats/memes-mint-stats';
import { sqlExecutor } from '@/sql-executor';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: {
    execute: jest.fn(),
    oneOrNull: jest.fn()
  }
}));

type MintTransactionRow = {
  token_count: number | string | null;
  eth_price_usd: number | string | null;
};

type RedeemedAggregateRow = {
  redeemedCount: number | string | null;
  redeemedUsdPrice: number | string | null;
};

type ExpectedStats = {
  total_count: number;
  mint_count: number;
  subscriptions_count: number;
  proceeds_eth: number;
  proceeds_usd: number;
  artist_split_eth: number;
  artist_split_usd: number;
};

type TestCase = {
  name: string;
  tokenId: number;
  mintDate: Date;
  mintTransactions: MintTransactionRow[];
  redeemedAgg: RedeemedAggregateRow | null;
  expectedFallbackEthUsd: number;
  expected: ExpectedStats;
};

function roundUsd(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function buildExpected({
  mintTransactions,
  subscriptionsCount,
  redeemedUsdPrice
}: {
  mintTransactions: MintTransactionRow[];
  subscriptionsCount: number;
  redeemedUsdPrice: number;
}): ExpectedStats {
  const nonZeroEthUsd = mintTransactions
    .map((tx) => Number(tx.eth_price_usd ?? 0))
    .filter((value) => value > 0);
  const fallbackEthUsd =
    nonZeroEthUsd.length > 0
      ? nonZeroEthUsd.reduce((sum, value) => sum + value, 0) /
        nonZeroEthUsd.length
      : 0;
  const mintCount = mintTransactions.reduce(
    (sum, tx) => sum + Number(tx.token_count ?? 0),
    0
  );
  const mintedUsdPrice = mintTransactions.reduce((sum, tx) => {
    const ethUsdRaw = Number(tx.eth_price_usd ?? 0);
    const ethUsd = ethUsdRaw > 0 ? ethUsdRaw : fallbackEthUsd;
    return sum + Number(tx.token_count ?? 0) * MEMES_MINT_PRICE * ethUsd;
  }, 0);
  const totalCount = mintCount + subscriptionsCount;
  const proceedsUsd = roundUsd(mintedUsdPrice + redeemedUsdPrice);

  return {
    total_count: totalCount,
    mint_count: mintCount,
    subscriptions_count: subscriptionsCount,
    proceeds_eth: totalCount * MEMES_MINT_PRICE,
    proceeds_usd: proceedsUsd,
    artist_split_eth: totalCount * MEMES_MINT_PRICE * 0.5,
    artist_split_usd: roundUsd(proceedsUsd * 0.5)
  };
}

describe('calculateMemesMintStats', () => {
  const sqlExecutorExecuteMock = sqlExecutor.execute as jest.MockedFunction<
    typeof sqlExecutor.execute
  >;
  const sqlExecutorOneOrNullMock =
    sqlExecutor.oneOrNull as jest.MockedFunction<typeof sqlExecutor.oneOrNull>;

  const cases: TestCase[] = [
    {
      name: 'calculates mint-only stats from direct mint transactions',
      tokenId: 1,
      mintDate: new Date('2025-01-02T00:00:00.000Z'),
      mintTransactions: [
        { token_count: 1, eth_price_usd: 1000 },
        { token_count: 2, eth_price_usd: 1100 }
      ],
      redeemedAgg: {
        redeemedCount: 0,
        redeemedUsdPrice: 0
      },
      expectedFallbackEthUsd: 1050,
      expected: buildExpected({
        mintTransactions: [
          { token_count: 1, eth_price_usd: 1000 },
          { token_count: 2, eth_price_usd: 1100 }
        ],
        subscriptionsCount: 0,
        redeemedUsdPrice: 0
      })
    },
    {
      name: 'splits direct mints and redeemed subscriptions',
      tokenId: 2,
      mintDate: new Date('2025-01-03T00:00:00.000Z'),
      mintTransactions: [{ token_count: 2, eth_price_usd: 1200 }],
      redeemedAgg: {
        redeemedCount: 3,
        redeemedUsdPrice: 250.51
      },
      expectedFallbackEthUsd: 1200,
      expected: buildExpected({
        mintTransactions: [{ token_count: 2, eth_price_usd: 1200 }],
        subscriptionsCount: 3,
        redeemedUsdPrice: 250.51
      })
    },
    {
      name: 'uses fallback ETH USD pricing when mint transactions have zero USD price',
      tokenId: 3,
      mintDate: new Date('2025-01-04T00:00:00.000Z'),
      mintTransactions: [
        { token_count: 1, eth_price_usd: 0 },
        { token_count: 1, eth_price_usd: 1000 },
        { token_count: 1, eth_price_usd: 2000 }
      ],
      redeemedAgg: {
        redeemedCount: 1,
        redeemedUsdPrice: 97.94
      },
      expectedFallbackEthUsd: 1500,
      expected: buildExpected({
        mintTransactions: [
          { token_count: 1, eth_price_usd: 0 },
          { token_count: 1, eth_price_usd: 1000 },
          { token_count: 1, eth_price_usd: 2000 }
        ],
        subscriptionsCount: 1,
        redeemedUsdPrice: 97.94
      })
    },
    {
      name: 'rounds proceeds USD and artist split USD consistently',
      tokenId: 4,
      mintDate: new Date('2025-01-05T00:00:00.000Z'),
      mintTransactions: [{ token_count: 1, eth_price_usd: 10.005 }],
      redeemedAgg: {
        redeemedCount: 0,
        redeemedUsdPrice: 0
      },
      expectedFallbackEthUsd: 10.005,
      expected: buildExpected({
        mintTransactions: [{ token_count: 1, eth_price_usd: 10.005 }],
        subscriptionsCount: 0,
        redeemedUsdPrice: 0
      })
    }
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(cases)('$name', async (testCase) => {
    sqlExecutorExecuteMock.mockResolvedValueOnce(testCase.mintTransactions);
    sqlExecutorOneOrNullMock.mockResolvedValueOnce(testCase.redeemedAgg);

    const result = await calculateMemesMintStats(
      testCase.tokenId,
      testCase.mintDate
    );

    expect(sqlExecutorExecuteMock).toHaveBeenCalledWith(
      expect.stringContaining('SELECT token_count, eth_price_usd'),
      { tokenId: testCase.tokenId }
    );
    expect(sqlExecutorOneOrNullMock).toHaveBeenCalledWith(
      expect.stringContaining('SELECT'),
      {
        tokenId: testCase.tokenId,
        mintPrice: MEMES_MINT_PRICE,
        fallbackEthUsd: testCase.expectedFallbackEthUsd
      }
    );
    expect(result).toMatchObject({
      id: testCase.tokenId,
      mint_date: testCase.mintDate,
      ...testCase.expected
    });
  });
});
