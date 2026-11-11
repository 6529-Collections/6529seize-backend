import { DataSource } from 'typeorm';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_CONTRACTS_TABLE,
  EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
  XTDH_GRANTS_TABLE,
  XTDH_STATS_META_TABLE,
  XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import { Time } from '@/time';
import { XTdhRepository } from './xtdh.repository';
import { XTdhStatsDb } from './xtdh-stats.db';

const OWNER = '0x0000000000000000000000000000000000000002';
const START = Time.latestUtcMidnight().toMillis() - Time.days(5).toMillis();
const GRANT_TABLE = `${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}b`;
const RATE = 10;

type Collection = {
  readonly contract: string;
  readonly totalSupply: number | null;
  readonly observedTokens: number;
};

// More token ids owned than the contract reported when it was snapshotted.
const OVER_SUPPLY: Collection = {
  contract: '0x00000000000000000000000000000000000000a1',
  totalSupply: 2,
  observedTokens: 5
};
// Fewer owned ids than the recorded supply: the divisor stays the supply.
const UNDER_SUPPLY: Collection = {
  contract: '0x00000000000000000000000000000000000000a2',
  totalSupply: 4,
  observedTokens: 2
};
// No recorded supply: the grant pays nothing, as before.
const NO_SUPPLY: Collection = {
  contract: '0x00000000000000000000000000000000000000a3',
  totalSupply: null,
  observedTokens: 3
};
const COLLECTIONS = [OVER_SUPPLY, UNDER_SUPPLY, NO_SUPPLY];
const partition = (collection: Collection) => `1:${collection.contract}`;
const grantId = (collection: Collection) => `grant-${collection.contract}`;

const seeds: Seed[] = [
  {
    table: XTDH_GRANTS_TABLE,
    rows: COLLECTIONS.map((collection) => ({
      id: grantId(collection),
      grantor_id: 'grantor',
      target_chain: 1,
      target_contract: collection.contract,
      target_partition: partition(collection),
      token_mode: 'ALL',
      created_at: START,
      updated_at: START,
      valid_from: START,
      rate: RATE,
      status: 'GRANTED',
      is_irrevocable: false
    }))
  },
  {
    table: EXTERNAL_INDEXED_CONTRACTS_TABLE,
    rows: COLLECTIONS.map((collection) => ({
      partition: partition(collection),
      chain: 1,
      contract: collection.contract,
      total_supply: collection.totalSupply,
      created_at: START,
      updated_at: START
    }))
  },
  {
    table: EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
    rows: COLLECTIONS.flatMap((collection) =>
      Array.from({ length: collection.observedTokens }, (_, i) => ({
        partition: partition(collection),
        token_id: i + 1,
        block_number: 1,
        log_index: i,
        owner: OWNER,
        since_block: 1,
        since_time: START,
        created_at: START,
        updated_at: START
      }))
    )
  },
  {
    table: ADDRESS_CONSOLIDATION_KEY,
    rows: [{ address: OWNER, consolidation_key: OWNER }]
  },
  {
    table: XTDH_STATS_META_TABLE,
    rows: [
      {
        id: 1,
        active_slot: 'a',
        as_of_midnight_ms: START,
        last_updated_at: new Date(START)
      }
    ]
  }
];

describeWithSeed('xTDH grant divisor', seeds, () => {
  const dataSource = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    timezone: 'Etc/UTC',
    extra: { connectionLimit: 2 }
  });
  let repository: XTdhRepository;
  let previousEpoch: string | undefined;

  beforeAll(async () => {
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(() => {
    repository = new XTdhRepository(
      () => sqlExecutor,
      new XTdhStatsDb(() => dataSource)
    );
    previousEpoch = process.env.XTDH_EPOCH_DATE;
    process.env.XTDH_EPOCH_DATE = '01-01-2020';
  });

  afterEach(() => {
    if (previousEpoch === undefined) {
      delete process.env.XTDH_EPOCH_DATE;
    } else {
      process.env.XTDH_EPOCH_DATE = previousEpoch;
    }
  });

  async function dailyCreditByGrant(): Promise<Map<string, number[]>> {
    await repository.refillXTdhGrantStats({ slot: 'b' }, {});
    const rows = await sqlExecutor.execute<{
      grant_id: string;
      xtdh_rate_daily: number | string;
    }>(`SELECT grant_id, xtdh_rate_daily FROM ${GRANT_TABLE}`);
    const byGrant = new Map<string, number[]>();
    for (const row of rows) {
      byGrant.set(row.grant_id, [
        ...(byGrant.get(row.grant_id) ?? []),
        Number(row.xtdh_rate_daily)
      ]);
    }
    return byGrant;
  }

  it('never credits an all-tokens grant more than its rate per day when more tokens are owned than the recorded supply', async () => {
    const credits = (await dailyCreditByGrant()).get(grantId(OVER_SUPPLY))!;

    expect(credits).toHaveLength(OVER_SUPPLY.observedTokens);
    const total = credits.reduce((sum, credit) => sum + credit, 0);
    expect(total).toBeLessThanOrEqual(RATE + 1e-9);
    // Divided by the observed ids, not the recorded supply of 2.
    for (const credit of credits) {
      expect(credit).toBeCloseTo(RATE / OVER_SUPPLY.observedTokens, 9);
    }
  });

  it('keeps dividing by the recorded supply when no more tokens are owned', async () => {
    const credits = (await dailyCreditByGrant()).get(grantId(UNDER_SUPPLY))!;

    expect(credits).toHaveLength(UNDER_SUPPLY.observedTokens);
    for (const credit of credits) {
      expect(credit).toBeCloseTo(RATE / UNDER_SUPPLY.totalSupply!, 9);
    }
  });

  it('still pays nothing for a grant without a recorded supply', async () => {
    expect(
      (await dailyCreditByGrant()).get(grantId(NO_SUPPLY))
    ).toBeUndefined();
  });
});
