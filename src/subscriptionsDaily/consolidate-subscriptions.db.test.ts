import 'reflect-metadata';
import * as db from '@/db';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import {
  ADDRESS_CONSOLIDATION_KEY,
  MEMES_CONTRACT,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import {
  aTdhConsolidation,
  withTdhConsolidations
} from '@/tests/fixtures/tdh_consolidation.fixture';
import { consolidateSubscriptions } from './subscriptions';
import { synchronizeAutomaticSubscriptionQuantities } from './subscription-quantity-sync.db';

// Exercise the real consolidation transaction against the isolated Jest MySQL database.
const A = '0xa';
const B = '0xb';
const C = '0xc';
const D = '0xd';
const AB = `${A}-${B}`;
const CD = `${C}-${D}`;
const EARLY = '2026-10-02 00:00:00';
const LATE = '2026-10-05 00:00:00';
type FixtureRow = Record<string, unknown>;
const logger = Logger.get('SUBSCRIPTIONS');

function upcoming(
  key: string,
  tokenId: number,
  count: number,
  automatic: boolean,
  priority = EARLY,
  subscribed = true
): FixtureRow {
  return {
    consolidation_key: key,
    contract: MEMES_CONTRACT,
    token_id: tokenId,
    subscribed_count: count,
    subscribed,
    automatic_subscription: automatic,
    created_at: priority,
    updated_at: priority
  };
}

function finalAllocation(key: string, tokenId: number): FixtureRow {
  return {
    consolidation_key: key,
    contract: MEMES_CONTRACT,
    token_id: tokenId,
    subscribed_count: 2,
    airdrop_address: key,
    balance: 10,
    subscribed_at: EARLY,
    phase: 'test-phase',
    phase_subscriptions: 2,
    phase_position: 7,
    redeemed_count: 1,
    created_at: EARLY,
    updated_at: EARLY
  };
}

function mergeSeeds(rows: FixtureRow[], extra: Seed[] = []): Seed[] {
  return [
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [A, B].map((address) => ({ address, consolidation_key: AB }))
    },
    withTdhConsolidations([aTdhConsolidation([A, B], { boosted_tdh: 100 })]),
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [
        { consolidation_key: A, balance: 2 },
        { consolidation_key: B, balance: 3 }
      ]
    },
    {
      table: SUBSCRIPTIONS_MODE_TABLE,
      rows: [
        { consolidation_key: A, automatic: true },
        { consolidation_key: B, automatic: false }
      ]
    },
    { table: SUBSCRIPTIONS_NFTS_TABLE, rows },
    ...extra
  ];
}

interface SavedUpcoming {
  id: number;
  consolidation_key: string;
  token_id: number;
  subscribed_count: number;
  subscribed: boolean | number;
  automatic_subscription: boolean | number;
  priority: string;
}

async function savedUpcoming() {
  return sqlExecutor.execute<SavedUpcoming>(
    `SELECT id, consolidation_key, token_id, subscribed_count, subscribed,
      automatic_subscription, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS priority
     FROM ${SUBSCRIPTIONS_NFTS_TABLE} ORDER BY consolidation_key, token_id`
  );
}

async function balances() {
  return sqlExecutor.execute<{ consolidation_key: string; balance: number }>(
    `SELECT consolidation_key, balance FROM ${SUBSCRIPTIONS_BALANCES_TABLE}
     ORDER BY consolidation_key`
  );
}

async function modes() {
  return sqlExecutor.execute<{
    consolidation_key: string;
    automatic: boolean;
    subscribe_all_editions: boolean;
  }>(
    `SELECT consolidation_key, automatic, subscribe_all_editions FROM ${SUBSCRIPTIONS_MODE_TABLE}
     ORDER BY consolidation_key`
  );
}

beforeAll(async () => {
  expect(process.env.DB_HOST).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(process.env.DB_NAME).toMatch(/_jest_worker_\d+$/);
  expect(Number(process.env.DB_PORT)).not.toBe(3306);
  await db.connect([], false, {
    database: process.env.DB_NAME!,
    failOnInitializationError: true
  });
});

afterAll(async () => {
  if (db.getDataSource()?.isInitialized) await db.disconnect();
});

describeWithSeed(
  'Real MySQL: overlapping upcoming subscriptions',
  mergeSeeds([
    upcoming(A, 600, 2, true, LATE),
    upcoming(B, 600, 3, false),
    upcoming(B, 601, 4, true, LATE)
  ]),
  () => {
    it('reproduces the legacy bulk-update duplicate error and stranded unrelated card', async () => {
      await db.getDataSource().transaction(async (manager) => {
        await manager.query(
          `UPDATE ${SUBSCRIPTIONS_NFTS_TABLE} SET consolidation_key = ? WHERE consolidation_key = ?`,
          [AB, A]
        );
        await expect(
          manager.query(
            `UPDATE ${SUBSCRIPTIONS_NFTS_TABLE} SET consolidation_key = ? WHERE consolidation_key = ?`,
            [AB, B]
          )
        ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
      });
      const stranded = (await savedUpcoming()).filter(
        (row) => row.consolidation_key === B
      );
      expect(stranded.map((row) => Number(row.token_id))).toEqual([600, 601]);
    });

    it('combines the duplicate and also moves the unrelated card without orphaning either', async () => {
      await consolidateSubscriptions(new Set([A, B]));
      const rows = await savedUpcoming();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.consolidation_key === AB)).toBe(true);
      const duplicate = rows.find((row) => Number(row.token_id) === 600)!;
      expect(duplicate.subscribed_count).toBe(3);
      expect(Boolean(duplicate.subscribed)).toBe(true);
      expect(Boolean(duplicate.automatic_subscription)).toBe(false);
      expect(duplicate.priority).toBe(EARLY);
      const distinct = rows.find((row) => Number(row.token_id) === 601)!;
      expect(distinct.subscribed_count).toBe(4);
      expect(distinct.priority).toBe(LATE);
      expect(await balances()).toEqual([{ consolidation_key: AB, balance: 5 }]);
      expect(Boolean((await modes())[0].automatic)).toBe(true);
    });

    it('does not duplicate counts or balances or change card priority on a repeated run', async () => {
      await consolidateSubscriptions(new Set([A, B]));
      const before = {
        rows: await savedUpcoming(),
        balances: await balances(),
        modes: await modes()
      };
      await consolidateSubscriptions(new Set([A, B]));
      expect(await savedUpcoming()).toEqual(before.rows);
      expect(await balances()).toEqual(before.balances);
      expect(await modes()).toEqual(before.modes);
    });
  }
);

for (const active of [A, B]) {
  describeWithSeed(
    `Real MySQL: only ${active} is subscribed`,
    mergeSeeds([
      upcoming(A, 600, active === A ? 2 : 9, active === A, LATE, active === A),
      upcoming(B, 600, active === B ? 2 : 9, active === B, EARLY, active === B)
    ]),
    () => {
      it('ignores the unsubscribed row count, manual preference and timestamp', async () => {
        await consolidateSubscriptions(new Set([A, B]));
        const [row] = await savedUpcoming();
        expect(row.consolidation_key).toBe(AB);
        expect(Boolean(row.subscribed)).toBe(true);
        expect(row.subscribed_count).toBe(2);
        expect(Boolean(row.automatic_subscription)).toBe(true);
        expect(row.priority).toBe(active === A ? LATE : EARLY);
      });
    }
  );
}

describeWithSeed(
  'Real MySQL: neither row is subscribed',
  mergeSeeds([
    upcoming(A, 600, 4, true, EARLY, false),
    upcoming(B, 600, 9, false, LATE, false)
  ]),
  () => {
    it('keeps the surviving row unsubscribed without adopting the redundant row preferences', async () => {
      await consolidateSubscriptions(new Set([A, B]));
      const rows = await savedUpcoming();
      expect(rows).toHaveLength(1);
      expect(Boolean(rows[0].subscribed)).toBe(false);
      expect(rows[0].subscribed_count).toBe(4);
      expect(Boolean(rows[0].automatic_subscription)).toBe(true);
      expect(rows[0].priority).toBe(EARLY);
    });
  }
);

describeWithSeed(
  'Real MySQL: pre-existing destination state',
  mergeSeeds(
    [
      upcoming(A, 600, 2, true, LATE),
      upcoming(B, 600, 3, false),
      upcoming(AB, 600, 5, false)
    ],
    [
      {
        table: SUBSCRIPTIONS_BALANCES_TABLE,
        rows: [{ consolidation_key: AB, balance: 7 }]
      },
      {
        table: SUBSCRIPTIONS_MODE_TABLE,
        rows: [{ consolidation_key: AB, automatic: false }]
      },
      {
        table: SUBSCRIPTIONS_LOGS_TABLE,
        rows: [
          { consolidation_key: A, log: 'test-A' },
          { consolidation_key: B, log: 'test-B' }
        ]
      },
      {
        table: SUBSCRIPTIONS_REDEEMED_TABLE,
        rows: [A, B].map((key) => ({
          contract: MEMES_CONTRACT,
          token_id: 599,
          address: key,
          transaction: `test-${key}`,
          consolidation_key: key,
          value: 1,
          balance_after: 2,
          count: 1
        }))
      }
    ]
  ),
  () => {
    it('includes the destination balance once and preserves logs and redeemed rows', async () => {
      await consolidateSubscriptions(new Set([A, B]));
      const rows = await savedUpcoming();
      expect(rows).toHaveLength(1);
      expect(rows[0].consolidation_key).toBe(AB);
      expect(rows[0].subscribed_count).toBe(5);
      expect(Boolean(rows[0].automatic_subscription)).toBe(false);
      expect(await balances()).toEqual([
        { consolidation_key: AB, balance: 12 }
      ]);
      for (const table of [
        SUBSCRIPTIONS_LOGS_TABLE,
        SUBSCRIPTIONS_REDEEMED_TABLE
      ]) {
        const moved = await sqlExecutor.execute<{ consolidation_key: string }>(
          `SELECT consolidation_key FROM ${table}`
        );
        expect(moved).toHaveLength(2);
        expect(moved.every((row) => row.consolidation_key === AB)).toBe(true);
      }
    });
  }
);

describeWithSeed(
  'Real MySQL: final allocation conflicts',
  mergeSeeds(
    [],
    [
      {
        table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
        rows: [
          finalAllocation(A, 700),
          finalAllocation(B, 700),
          finalAllocation(B, 701)
        ]
      }
    ]
  ),
  () => {
    it('keeps and logs the conflicting allocation while moving the distinct allocation unchanged', async () => {
      const log = jest.spyOn(logger, 'error');
      try {
        await consolidateSubscriptions(new Set([A, B]));
        const rows = await sqlExecutor.execute<{
          consolidation_key: string;
          token_id: number;
          airdrop_address: string;
          subscribed_count: number;
          phase: string;
          phase_position: number;
          redeemed_count: number;
          priority: string;
        }>(`SELECT consolidation_key, token_id, airdrop_address, subscribed_count,
             phase, phase_position, redeemed_count,
             DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS priority
           FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} ORDER BY consolidation_key, token_id`);
        expect(rows).toHaveLength(3);
        const conflict = rows.find((row) => row.consolidation_key === B)!;
        expect(Number(conflict.token_id)).toBe(700);
        expect(conflict.airdrop_address).toBe(B);
        const distinct = rows.find((row) => Number(row.token_id) === 701)!;
        expect(distinct.consolidation_key).toBe(AB);
        expect(distinct.airdrop_address).toBe(B);
        expect(distinct.phase).toBe('test-phase');
        expect(distinct.phase_position).toBe(7);
        expect(distinct.redeemed_count).toBe(1);
        expect(distinct.subscribed_count).toBe(2);
        expect(distinct.priority).toBe(EARLY);
        expect(
          rows.find(
            (row) =>
              row.consolidation_key === AB && Number(row.token_id) === 700
          )?.airdrop_address
        ).toBe(A);
        expect(
          log.mock.calls.some((args) =>
            String(args[0]).includes('[FINAL SUBSCRIPTION MERGE CONFLICT]')
          )
        ).toBe(true);
      } finally {
        log.mockRestore();
      }
    });
  }
);

describeWithSeed(
  'Real MySQL: split subscription destination',
  [
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [
        { address: A, consolidation_key: A },
        ...[B, C].map((address) => ({
          address,
          consolidation_key: `${B}-${C}`
        }))
      ]
    },
    withTdhConsolidations([
      aTdhConsolidation([A], { boosted_tdh: 2 }),
      aTdhConsolidation([B, C], { boosted_tdh: 8 })
    ]),
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [{ consolidation_key: `${A}-${B}-${C}`, balance: 10 }]
    },
    {
      table: SUBSCRIPTIONS_MODE_TABLE,
      rows: [{ consolidation_key: `${A}-${B}-${C}`, automatic: true }]
    },
    {
      table: SUBSCRIPTIONS_NFTS_TABLE,
      rows: [upcoming(`${A}-${B}-${C}`, 600, 2, false)]
    }
  ],
  () => {
    it('keeps the existing rule that subscriptions follow the higher-TDH resulting group', async () => {
      await consolidateSubscriptions(new Set([A]));
      const [row] = await savedUpcoming();
      expect(row.consolidation_key).toBe(`${B}-${C}`);
      expect(row.priority).toBe(EARLY);
      expect(await balances()).toEqual([
        { consolidation_key: `${B}-${C}`, balance: 10 }
      ]);
    });
  }
);

const faultSeeds = mergeSeeds(
  [
    upcoming(A, 600, 2, true, LATE),
    upcoming(B, 600, 3, false),
    upcoming(B, 602, 4, true),
    upcoming(C, 603, 1, false)
  ],
  [
    {
      table: ADDRESS_CONSOLIDATION_KEY,
      rows: [C, D].map((address) => ({ address, consolidation_key: CD }))
    },
    withTdhConsolidations([aTdhConsolidation([C, D], { boosted_tdh: 50 })]),
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [{ consolidation_key: C, balance: 9 }]
    },
    {
      table: SUBSCRIPTIONS_MODE_TABLE,
      rows: [{ consolidation_key: C, automatic: false }]
    }
  ]
);

describeWithSeed(
  'Real MySQL: group savepoint rollback and retry',
  faultSeeds,
  () => {
    it('undoes an already-updated duplicate and deletion, commits the other group, and retries without losses', async () => {
      const before = (await savedUpcoming()).filter(
        (row) => row.consolidation_key !== C
      );
      await sqlExecutor.execute(`CREATE TRIGGER acceptance_fail_subscription_rekey
      BEFORE UPDATE ON ${SUBSCRIPTIONS_NFTS_TABLE} FOR EACH ROW
      BEGIN
        IF OLD.consolidation_key = '${B}' AND NEW.consolidation_key = '${AB}' AND OLD.token_id = 602 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'acceptance rekey failure';
        END IF;
      END`);
      try {
        await consolidateSubscriptions(new Set([A, B, C, D]));
        const after = await savedUpcoming();
        expect(after.filter((row) => row.consolidation_key !== CD)).toEqual(
          before
        );
        expect(
          after.find((row) => Number(row.token_id) === 603)?.consolidation_key
        ).toBe(CD);
        expect(await balances()).toEqual([
          { consolidation_key: A, balance: 2 },
          { consolidation_key: B, balance: 3 },
          { consolidation_key: CD, balance: 9 }
        ]);
      } finally {
        await sqlExecutor.execute(
          'DROP TRIGGER IF EXISTS acceptance_fail_subscription_rekey'
        );
      }
      await consolidateSubscriptions(new Set([A, B, C, D]));
      const retried = await savedUpcoming();
      expect(retried).toHaveLength(3);
      expect(
        retried.every(
          (row) => row.consolidation_key === AB || row.consolidation_key === CD
        )
      ).toBe(true);
      expect(
        retried.find((row) => Number(row.token_id) === 600)?.subscribed_count
      ).toBe(3);
      expect(await balances()).toEqual([
        { consolidation_key: AB, balance: 5 },
        { consolidation_key: CD, balance: 9 }
      ]);
    });
  }
);

describeWithSeed('Real MySQL: lost transaction abort', faultSeeds, () => {
  it('preserves the original database error and aborts after a forced real rollback loses its savepoint', async () => {
    const before = {
      rows: await savedUpcoming(),
      balances: await balances(),
      modes: await modes()
    };
    const source = db.getDataSource();
    const createRunner = source.createQueryRunner.bind(source);
    let injected = false;
    const factory = jest
      .spyOn(source, 'createQueryRunner')
      .mockImplementation((mode) => {
        const runner = createRunner(mode);
        const query = runner.query.bind(runner);
        jest.spyOn(runner, 'query').mockImplementation(async (sql, params) => {
          if (
            !injected &&
            sql.includes(`UPDATE ${SUBSCRIPTIONS_NFTS_TABLE}\n`) &&
            sql.includes('SET consolidation_key') &&
            params?.[1] === B
          ) {
            injected = true;
            // Deliberately reproduce lost-transaction semantics in MySQL.
            // This is fault injection, not a naturally occurring deadlock.
            await query('ROLLBACK');
            return query(
              "SIGNAL SQLSTATE '40001' SET MYSQL_ERRNO = 1213, MESSAGE_TEXT = 'acceptance lost transaction'"
            );
          }
          return query(sql, params);
        });
        return runner;
      });
    try {
      await expect(
        consolidateSubscriptions(new Set([A, B, C, D]))
      ).rejects.toThrow('acceptance lost transaction');
      expect(injected).toBe(true);
      expect(await savedUpcoming()).toEqual(before.rows);
      expect(await balances()).toEqual(before.balances);
      expect(await modes()).toEqual(before.modes);
    } finally {
      factory.mockRestore();
    }
  });
});

for (const scenario of [
  {
    name: 'first source',
    sourceA: true,
    sourceB: false,
    destination: false,
    automatic: true
  },
  {
    name: 'second source',
    sourceA: false,
    sourceB: true,
    destination: false,
    automatic: true
  },
  {
    name: 'existing destination',
    sourceA: false,
    sourceB: false,
    destination: true,
    automatic: true
  },
  {
    name: 'all groups',
    sourceA: true,
    sourceB: true,
    destination: true,
    automatic: true
  },
  {
    name: 'One edition everywhere',
    sourceA: false,
    sourceB: false,
    destination: false,
    automatic: true
  },
  {
    name: 'saved All eligible in Manual mode',
    sourceA: true,
    sourceB: false,
    destination: false,
    automatic: false
  }
]) {
  const seeds = mergeSeeds([]);
  const sourceModes = seeds.find(
    (seed) => seed.table === SUBSCRIPTIONS_MODE_TABLE
  )!;
  sourceModes.rows = [
    {
      consolidation_key: A,
      automatic: scenario.automatic,
      subscribe_all_editions: scenario.sourceA
    },
    {
      consolidation_key: B,
      automatic: false,
      subscribe_all_editions: scenario.sourceB
    },
    {
      consolidation_key: AB,
      automatic: false,
      subscribe_all_editions: scenario.destination
    }
  ];
  describeWithSeed(
    `Real MySQL: edition preference from ${scenario.name}`,
    seeds,
    () => {
      it('preserves the combined preference and mode across a merge and a repeated run', async () => {
        await consolidateSubscriptions(new Set([A, B]));
        const merged = await modes();
        expect(merged).toHaveLength(1);
        expect(merged[0].consolidation_key).toBe(AB);
        expect(Boolean(merged[0].automatic)).toBe(scenario.automatic);
        expect(Boolean(merged[0].subscribe_all_editions)).toBe(
          scenario.sourceA || scenario.sourceB || scenario.destination
        );
        await consolidateSubscriptions(new Set([A, B]));
        expect(await modes()).toEqual(merged);
      });
    }
  );
}

const editionFailureSeeds = mergeSeeds([]);
editionFailureSeeds.find(
  (seed) => seed.table === SUBSCRIPTIONS_MODE_TABLE
)!.rows[0].subscribe_all_editions = true;
describeWithSeed(
  'Real MySQL: edition preference rollback',
  editionFailureSeeds,
  () => {
    it('restores both settings after a failed replacement insert, then preserves them on retry', async () => {
      const before = { modes: await modes(), balances: await balances() };
      await sqlExecutor.execute(`CREATE TRIGGER acceptance_fail_mode_insert
      BEFORE INSERT ON ${SUBSCRIPTIONS_MODE_TABLE} FOR EACH ROW
      BEGIN
        IF NEW.consolidation_key = '${AB}' THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'acceptance mode insert failure';
        END IF;
      END`);
      try {
        await consolidateSubscriptions(new Set([A, B]));
        expect(await modes()).toEqual(before.modes);
        expect(await balances()).toEqual(before.balances);
      } finally {
        await sqlExecutor.execute(
          'DROP TRIGGER IF EXISTS acceptance_fail_mode_insert'
        );
      }
      await consolidateSubscriptions(new Set([A, B]));
      const [mode] = await modes();
      expect(mode.consolidation_key).toBe(AB);
      expect(Boolean(mode.automatic)).toBe(true);
      expect(Boolean(mode.subscribe_all_editions)).toBe(true);
    });
  }
);

for (const manualKey of [A, B, AB]) {
  const seeds = mergeSeeds([
    upcoming(A, 600, manualKey === A ? 2 : 8, manualKey !== A),
    upcoming(B, 600, manualKey === B ? 2 : 9, manualKey !== B),
    upcoming(AB, 600, manualKey === AB ? 2 : 10, manualKey !== AB),
    upcoming(A, 601, 5, true)
  ]);
  seeds.find(
    (seed) => seed.table === SUBSCRIPTIONS_MODE_TABLE
  )!.rows[0].subscribe_all_editions = true;
  describeWithSeed(
    `Real MySQL: smaller manual quantity on ${manualKey}`,
    seeds,
    () => {
      it('keeps the manual quantity while preserving Automatic / All eligible at group level', async () => {
        await consolidateSubscriptions(new Set([A, B]));
        const card = (await savedUpcoming()).find(
          (row) => Number(row.token_id) === 600
        )!;
        expect(card.consolidation_key).toBe(AB);
        expect(card.subscribed_count).toBe(2);
        expect(Boolean(card.automatic_subscription)).toBe(false);
        const [mode] = await modes();
        expect(Boolean(mode.automatic)).toBe(true);
        expect(Boolean(mode.subscribe_all_editions)).toBe(true);
        await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          synchronizeAutomaticSubscriptionQuantities([AB], {
            connection,
            timer: undefined
          })
        );
        const refreshed = await savedUpcoming();
        expect(
          refreshed.find((row) => Number(row.token_id) === 600)
            ?.subscribed_count
        ).toBe(2);
        // No season holdings means eligibility defaults to one. Updating the
        // automatic card proves the sync ran while the manual request stayed put.
        expect(
          refreshed.find((row) => Number(row.token_id) === 601)
            ?.subscribed_count
        ).toBe(1);
      });
    }
  );
}
