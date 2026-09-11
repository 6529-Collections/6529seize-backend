import { DataSource } from 'typeorm';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_CONTRACTS_TABLE,
  EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
  XTDH_GRANTS_TABLE,
  XTDH_STATS_META_TABLE,
  XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX,
  XTDH_TOKEN_STATS_TABLE_PREFIX
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import { Time } from '@/time';
import { XTdhRepository } from './xtdh.repository';
import { XTdhStatsDb } from './xtdh-stats.db';

const CONTRACT = '0x0000000000000000000000000000000000000001';
const OWNER = '0x0000000000000000000000000000000000000002';
const PARTITION = `1:${CONTRACT}`;
const START = Time.latestUtcMidnight().toMillis() - Time.days(5).toMillis();
const GRANT_TABLE = `${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}b`;
const TOKEN_TABLE = `${XTDH_TOKEN_STATS_TABLE_PREFIX}b`;
const seeds: Seed[] = [
  {
    table: XTDH_GRANTS_TABLE,
    rows: [
      {
        id: 'grant',
        grantor_id: 'grantor',
        target_chain: 1,
        target_contract: CONTRACT,
        target_partition: PARTITION,
        token_mode: 'ALL',
        created_at: START,
        updated_at: START,
        valid_from: START,
        rate: 10,
        status: 'GRANTED',
        is_irrevocable: false
      }
    ]
  },
  {
    table: EXTERNAL_INDEXED_CONTRACTS_TABLE,
    rows: [
      {
        partition: PARTITION,
        chain: 1,
        contract: CONTRACT,
        total_supply: 1,
        created_at: START,
        updated_at: START
      }
    ]
  },
  {
    table: EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
    rows: [
      {
        partition: PARTITION,
        token_id: 1,
        block_number: 1,
        log_index: 0,
        owner: OWNER,
        since_block: 1,
        since_time: START,
        created_at: START,
        updated_at: START
      }
    ]
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

describeWithSeed('xTDH stats nonlocking inserts', seeds, () => {
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
  const statsDb = new XTdhStatsDb(() => dataSource);
  let repository: XTdhRepository;
  let previousEpoch: string | undefined;

  beforeAll(async () => {
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(() => {
    repository = new XTdhRepository(() => sqlExecutor, statsDb);
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

  it('rebuilds both tables using committed values while a grant writer holds a lock', async () => {
    const writer = dataSource.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    try {
      await writer.query(
        `UPDATE ${XTDH_GRANTS_TABLE} SET rate = 999 WHERE id = 'grant'`
      );
      // Configure the other pool connection. A locking source read would fail
      // promptly instead of hanging this regression test for MySQL's default.
      await dataSource.query('SET SESSION innodb_lock_wait_timeout = 1');

      await repository.refillXTdhGrantStats({ slot: 'b' }, {});
      await repository.refillXTdhTokenStats({ slot: 'b' }, {});

      const [grantStats] = await sqlExecutor.execute(
        `SELECT xtdh_total, xtdh_rate_daily FROM ${GRANT_TABLE}`
      );
      expect(grantStats).toEqual({ xtdh_total: 40, xtdh_rate_daily: 10 });
      const [tokenStats] = await sqlExecutor.execute(
        `SELECT owner, xtdh_total, xtdh_rate_daily, grant_count FROM ${TOKEN_TABLE}`
      );
      expect(tokenStats).toEqual({
        owner: OWNER,
        xtdh_total: 40,
        xtdh_rate_daily: 10,
        grant_count: 1
      });
      expect(await repository.getStatsMetaOrNull({})).toMatchObject({
        active_slot: 'a'
      });
      const [session] = await dataSource.query(
        'SELECT @@SESSION.transaction_isolation AS isolation_level'
      );
      expect(session.isolation_level).toBe('REPEATABLE-READ');
    } finally {
      await writer.rollbackTransaction();
      await writer.release();
    }
  });

  it('rolls back a failed insert and releases the connection for a retry', async () => {
    const runnerFactory = jest.spyOn(dataSource, 'createQueryRunner');
    try {
      // The second row violates the composite primary key after the first
      // row was inserted. The whole statement/transaction must roll back.
      await expect(
        statsDb.insertFromSelect(
          `INSERT INTO ${GRANT_TABLE}
           (grant_id, \`partition\`, token_id, xtdh_total, xtdh_rate_daily)
           SELECT 'grant', 'partition', 1, :total, 10
           UNION ALL SELECT 'grant', 'partition', 1, :total, 10`,
          { total: 40 },
          {}
        )
      ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
      expect(runnerFactory.mock.results[0].value.isReleased).toBe(true);
      expect(await sqlExecutor.execute(`SELECT * FROM ${GRANT_TABLE}`)).toEqual(
        []
      );
      await repository.refillXTdhGrantStats({ slot: 'b' }, {});
      expect(
        await sqlExecutor.execute(`SELECT * FROM ${GRANT_TABLE}`)
      ).toHaveLength(1);
    } finally {
      runnerFactory.mockRestore();
    }
  });

  it.each(['refillXTdhGrantStats', 'refillXTdhTokenStats'] as const)(
    '%s rejects a caller transaction before truncating anything',
    async (method) => {
      const execute = jest.spyOn(sqlExecutor, 'execute');
      try {
        await expect(
          repository[method]({ slot: 'b' }, { connection: { connection: {} } })
        ).rejects.toThrow('must own its transactions');
        expect(execute).not.toHaveBeenCalled();
      } finally {
        execute.mockRestore();
      }
    }
  );
});
