import { MEMES_CONTRACT } from '@/constants';
import { assembleOpening } from './opening-assemble';
import { LegacyTables } from './legacy-tables';
import { OpeningFile } from './opening-file';
import { parseOpeningFiles, ParsedOpening } from './opening-load';
import {
  EthMintsFixture,
  EthTopUpsFixture,
  verifyOpening
} from './opening-verify';

jest.mock('@/sql-executor', () => ({ sqlExecutor: {} }));

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const P1 = `0x${'1'.padStart(64, '0')}`;
const A = wallet(1);
const B = wallet(2);
const LONE = wallet(4);
const T = '2026-11-20 10:00:00.000000';

/** LONE topped up 0.2 and was charged one card; P1 topped up 0.1, never charged. */
const tables: LegacyTables = {
  balances: [
    {
      consolidation_key: LONE,
      balance: 0.13471,
      created_at: T,
      updated_at: T
    },
    {
      consolidation_key: `${A}-${B}`,
      balance: 0.1,
      created_at: T,
      updated_at: T
    }
  ],
  modes: [],
  choices: [],
  topUps: [
    {
      hash: '0xaa',
      block: 10,
      transaction_date: T,
      from_wallet: LONE,
      amount: 0.2,
      created_at: T
    },
    {
      hash: '0xbb',
      block: 11,
      transaction_date: T,
      from_wallet: A,
      amount: 0.1,
      created_at: T
    }
  ],
  finalRows: [],
  uploads: [],
  redeemed: [
    {
      consolidation_key: LONE,
      contract: MEMES_CONTRACT,
      token_id: 500,
      address: LONE,
      transaction: '0xt1',
      transaction_date: '2026-11-20 15:00:00.000000',
      value: 0.06529,
      balance_after: 0.13471,
      count: 1,
      created_at: T
    }
  ],
  logs: [],
  queue: []
};

const cut = {
  at: '2026-11-26T12:00:00.000Z',
  maxMemeId: 579,
  topUpBlock: 20,
  redemptionBlock: 30,
  mintPrice: 0.06529
};

function parsedOf(t: LegacyTables = tables): ParsedOpening {
  const files = assembleOpening(
    cut,
    t,
    new Map([
      [A, P1],
      [B, P1]
    ])
  );
  return parseOpeningFiles(files.openingBytes, files.historyBytes);
}

const topUps: EthTopUpsFixture = {
  fromBlock: 0,
  toBlock: 20,
  transfers: [
    { hash: '0xaa', block: 10, from: LONE, amount: '0.2' },
    { hash: '0xbb', block: 11, from: A, amount: '0.1' }
  ]
};

const mints: EthMintsFixture = {
  fromDate: '2026-11-01T00:00:00Z',
  toDate: '2026-11-26T12:00:00Z',
  mints: [
    {
      transaction: '0xt1',
      to: LONE,
      contract: MEMES_CONTRACT,
      tokenId: 500,
      tokenCount: 1,
      transactionDate: '2026-11-20T15:00:00Z'
    }
  ]
};

function failing(report: ReturnType<typeof verifyOpening>) {
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe('verifyOpening', () => {
  it('passes a file that matches Ethereum, with conservation exact', () => {
    const report = verifyOpening(parsedOf(), { topUps, mints });
    expect(report.verdict).toBe('PASS');
    expect(failing(report)).toEqual([]);
    expect(report.conservation).toEqual({
      topUpSum: '0.3',
      redeemedValueSum: '0.06529',
      balanceSum: '0.23471',
      residual: '0',
      identities: 2,
      exact: 2,
      rounding: 0,
      adjustments: [],
      adjustmentSum: '0'
    });
  });

  it('fails on a top-up missing from the file, an extra one, or a wrong amount', () => {
    const report = verifyOpening(parsedOf(), {
      topUps: {
        ...topUps,
        transfers: [
          { hash: '0xaa', block: 10, from: LONE, amount: '0.25' },
          { hash: '0xcc', block: 12, from: B, amount: '1' }
        ]
      }
    });
    expect(report.verdict).toBe('FAIL');
    const check = report.checks.find(
      (c) => c.name === 'top-ups against Ethereum'
    );
    expect(check?.examples).toEqual([
      'amount: 0xaa is 0.25 on Ethereum, 0.2 here',
      'extra: 0xbb is not a top-up on Ethereum',
      'missing: 0xcc at block 12'
    ]);
  });

  it('fails on a redemption with no mint behind it', () => {
    const report = verifyOpening(parsedOf(), {
      mints: { ...mints, mints: [] }
    });
    expect(failing(report)).toEqual(['redemptions against Ethereum']);
  });

  it('lists a balance that top-ups and redemptions do not explain as an adjustment', () => {
    const report = verifyOpening(
      parsedOf({
        ...tables,
        balances: [{ ...tables.balances[0], balance: 0.5 }, tables.balances[1]]
      }),
      { topUps, mints }
    );
    // Adjustments are the owner's list (O4); they don't fail the file.
    expect(report.verdict).toBe('PASS');
    expect(report.conservation.adjustments).toEqual([
      {
        identityKey: LONE,
        balance: '0.5',
        topUps: '0.2',
        redeemed: '0.06529',
        residual: '0.36529'
      }
    ]);
    expect(report.conservation.residual).toBe('0.36529');
  });

  it('counts a five-decimal rounding difference as rounding, not an adjustment', () => {
    const report = verifyOpening(
      parsedOf({
        ...tables,
        balances: [
          { ...tables.balances[0], balance: 0.134714 },
          tables.balances[1]
        ]
      })
    );
    expect(report.conservation.rounding).toBe(1);
    expect(report.conservation.adjustments).toEqual([]);
  });

  it('fails a file whose stated totals differ from its rows', () => {
    const parsed = parsedOf();
    const tampered: OpeningFile = {
      ...parsed.opening,
      totals: { ...parsed.opening.totals, balanceSum: '9' }
    };
    const report = verifyOpening({ ...parsed, opening: tampered });
    expect(failing(report)).toEqual(['totals']);
  });

  it('fails a file with blocked keys', () => {
    const report = verifyOpening(
      parsedOf({
        ...tables,
        balances: [
          ...tables.balances,
          {
            consolidation_key: `${A}-${LONE}`,
            balance: 0,
            created_at: T,
            updated_at: T
          }
        ]
      })
    );
    expect(failing(report)).toContain('no blocked keys');
  });
});
