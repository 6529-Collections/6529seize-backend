import 'reflect-metadata';
import {
  updateSubscribeAllEditions,
  updateSubscription,
  updateSubscriptionCount,
  updateSubscriptionMode
} from '@/api/subscriptions/api.subscriptions.db';
import {
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  MEMES_CONTRACT,
  MEMES_SEASONS_TABLE,
  NFTS_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE
} from '@/constants';
import { connect, disconnect } from '@/db';
import * as Entities from '@/entities/entities';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { msToDbText } from '../opening/legacy-tables';
import type { SubscriptionChange } from '../records/subscription-records';
import { turnIdentityAutomaticOn } from './identity-automatic';
import { makeChoice } from './identity-choices';

jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

/*
 * The identity engine against the legacy writes: from the same rows in
 * both table sets, a change made by the legacy function and by makeChoice
 * must leave the same rows, move the same rows' times, add the same log
 * lines, and refuse with the same words.
 */

const W = `0x${'0'.repeat(39)}5`;
/** A card already released, and three upcoming ones. */
const RELEASED = 100;
const T0 = '2026-11-20 10:00:00.000000';

interface CardSeed {
  readonly token: number;
  readonly subscribed: boolean;
  readonly count: number;
  readonly automatic: boolean;
}

interface Seed {
  readonly balance: number | null;
  readonly mode: { automatic: boolean; all: boolean } | null;
  readonly cards: readonly CardSeed[];
  readonly eligibility: number;
}

const execute = (sql: string, params?: Record<string, unknown>) =>
  sqlExecutor.execute(sql, params);

/** Inserts a row, filling NOT NULL columns without a default with zeros. */
async function insertFilled(table: string, values: Record<string, unknown>) {
  const required = await sqlExecutor.execute<{ c: string; t: string }>(
    `SELECT column_name AS c, data_type AS t FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = :table
        AND is_nullable = 'NO' AND column_default IS NULL
        AND extra NOT LIKE '%auto_increment%'`,
    { table }
  );
  const row: Record<string, unknown> = { ...values };
  for (const { c, t } of required) {
    if (!(c in row)) {
      if (/date|time/.test(t)) {
        row[c] = '2026-01-01 00:00:00';
      } else if (/char|text/.test(t)) {
        row[c] = '';
      } else if (t === 'json') {
        row[c] = '{}';
      } else {
        row[c] = 0;
      }
    }
  }
  const columns = Object.keys(row);
  await execute(
    `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(', ')})
      VALUES (${columns.map((c) => `:${c}`).join(', ')})`,
    row
  );
}

async function seedBoth(seed: Seed) {
  await insertFilled(NFTS_TABLE, {
    id: RELEASED,
    contract: MEMES_CONTRACT,
    mint_date: '2026-11-01 00:00:00'
  });
  await insertFilled(MEMES_SEASONS_TABLE, { id: 1 });
  await insertFilled(CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE, {
    consolidation_key: W,
    season: 1,
    sets: seed.eligibility
  });
  const sides = [
    {
      key: 'consolidation_key',
      balances: SUBSCRIPTIONS_BALANCES_TABLE,
      mode: SUBSCRIPTIONS_MODE_TABLE,
      nfts: SUBSCRIPTIONS_NFTS_TABLE
    },
    {
      key: 'identity_key',
      balances: SUBSCRIPTIONS_ID_BALANCES_TABLE,
      mode: SUBSCRIPTIONS_ID_MODE_TABLE,
      nfts: SUBSCRIPTIONS_ID_NFTS_TABLE
    }
  ];
  for (const side of sides) {
    if (seed.balance !== null) {
      await execute(
        `INSERT INTO ${side.balances} (${side.key}, balance, created_at, updated_at)
          VALUES (:w, :balance, :t0, :t0)`,
        { w: W, balance: seed.balance, t0: T0 }
      );
    }
    if (seed.mode) {
      await execute(
        `INSERT INTO ${side.mode} (${side.key}, automatic, subscribe_all_editions, created_at, updated_at)
          VALUES (:w, :automatic, :all, :t0, :t0)`,
        { w: W, ...seed.mode, t0: T0 }
      );
    }
    for (const card of seed.cards) {
      await execute(
        `INSERT INTO ${side.nfts}
          (${side.key}, contract, token_id, subscribed, subscribed_count, automatic_subscription, created_at, updated_at)
          VALUES (:w, :contract, :token, :subscribed, :count, :automatic, :t0, :t0)`,
        { w: W, contract: MEMES_CONTRACT, t0: T0, ...card }
      );
    }
  }
}

/** What one side holds for W: values, whether each time moved, log lines. */
async function stateOf(side: 'legacy' | 'identity') {
  const [key, mode, nfts, logs] =
    side === 'legacy'
      ? [
          'consolidation_key',
          SUBSCRIPTIONS_MODE_TABLE,
          SUBSCRIPTIONS_NFTS_TABLE,
          SUBSCRIPTIONS_LOGS_TABLE
        ]
      : [
          'identity_key',
          SUBSCRIPTIONS_ID_MODE_TABLE,
          SUBSCRIPTIONS_ID_NFTS_TABLE,
          SUBSCRIPTIONS_ID_LOGS_TABLE
        ];
  const moved = (at: string) => (at === T0 ? 'kept' : 'moved');
  const modeRows = await sqlExecutor.execute<{
    automatic: number;
    subscribe_all_editions: number;
    at: string;
  }>(
    `SELECT automatic, subscribe_all_editions,
            DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS at
       FROM ${mode} WHERE ${key} = :w`,
    { w: W }
  );
  const cardRows = await sqlExecutor.execute<{
    token_id: number;
    subscribed: number;
    subscribed_count: number;
    automatic_subscription: number;
    at: string;
  }>(
    `SELECT token_id, subscribed, subscribed_count, automatic_subscription,
            DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS at
       FROM ${nfts} WHERE ${key} = :w ORDER BY token_id`,
    { w: W }
  );
  const lines = await sqlExecutor.execute<{
    log: string;
    additional_info: string | null;
  }>(`SELECT log, additional_info FROM ${logs} WHERE ${key} = :w ORDER BY id`, {
    w: W
  });
  return {
    mode: modeRows.map((m) => [
      Number(m.automatic),
      Number(m.subscribe_all_editions),
      moved(m.at)
    ]),
    cards: cardRows.map((c) => [
      Number(c.token_id),
      Number(c.subscribed),
      Number(c.subscribed_count),
      Number(c.automatic_subscription),
      moved(c.at)
    ]),
    lines: lines.map((l) => [l.log, l.additional_info])
  };
}

async function legacyChange(change: SubscriptionChange): Promise<void> {
  switch (change.type) {
    case 'subs.mode':
      await updateSubscriptionMode(W, change.automatic);
      return;
    case 'subs.all-editions':
      await updateSubscribeAllEditions(W, change.all);
      return;
    case 'subs.card':
      await updateSubscription(
        W,
        change.contract,
        change.tokenId,
        change.subscribed
      );
      return;
    case 'subs.count':
      await updateSubscriptionCount(
        W,
        change.contract,
        change.tokenId,
        change.count
      );
  }
}

async function identityChange(change: SubscriptionChange): Promise<void> {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const scope = {
      identityKey: W,
      consolidationKey: W,
      atText: msToDbText(Date.now()),
      options: { wrappedConnection: connection },
      rules: true
    };
    await makeChoice(scope, change);
  });
}

const outcome = (run: Promise<void>) =>
  run.then(
    () => 'applied',
    (error: Error) => `refused: ${error.message}`
  );

const card = (token: number, subscribed: boolean): SubscriptionChange => ({
  type: 'subs.card',
  contract: MEMES_CONTRACT,
  tokenId: token,
  subscribed
});
const count = (token: number, n: number): SubscriptionChange => ({
  type: 'subs.count',
  contract: MEMES_CONTRACT,
  tokenId: token,
  count: n
});

const upcoming: CardSeed[] = [
  { token: 102, subscribed: false, count: 1, automatic: false },
  { token: 103, subscribed: true, count: 1, automatic: true },
  { token: 104, subscribed: true, count: 2, automatic: false }
];

const cases: [string, Seed, SubscriptionChange][] = [
  [
    'automatic on, with all editions',
    {
      balance: 0.5,
      mode: { automatic: false, all: true },
      cards: upcoming,
      eligibility: 3
    },
    { type: 'subs.mode', automatic: true }
  ],
  [
    'automatic on again',
    {
      balance: 0.5,
      mode: { automatic: true, all: false },
      cards: upcoming,
      eligibility: 3
    },
    { type: 'subs.mode', automatic: true }
  ],
  [
    'manual',
    {
      balance: 0.5,
      mode: { automatic: true, all: true },
      cards: upcoming,
      eligibility: 3
    },
    { type: 'subs.mode', automatic: false }
  ],
  [
    'automatic on without the balance',
    { balance: 0.01, mode: null, cards: upcoming, eligibility: 1 },
    { type: 'subs.mode', automatic: true }
  ],
  [
    'automatic on with no balance row',
    { balance: null, mode: null, cards: [], eligibility: 1 },
    { type: 'subs.mode', automatic: true }
  ],
  [
    'all editions on, automatic',
    {
      balance: 0.5,
      mode: { automatic: true, all: false },
      cards: upcoming,
      eligibility: 3
    },
    { type: 'subs.all-editions', all: true }
  ],
  [
    'all editions off, no mode row yet',
    { balance: 0.5, mode: null, cards: upcoming, eligibility: 3 },
    { type: 'subs.all-editions', all: false }
  ],
  [
    'subscribe a card, all editions',
    {
      balance: 0.5,
      mode: { automatic: false, all: true },
      cards: upcoming,
      eligibility: 2
    },
    card(102, true)
  ],
  [
    'subscribe a card with no row',
    {
      balance: 0.5,
      mode: { automatic: false, all: false },
      cards: [],
      eligibility: 2
    },
    card(105, true)
  ],
  [
    'subscribe a card already subscribed',
    { balance: 0.5, mode: null, cards: upcoming, eligibility: 1 },
    card(104, true)
  ],
  [
    'unsubscribe a card',
    { balance: 0, mode: null, cards: upcoming, eligibility: 1 },
    card(103, false)
  ],
  [
    'subscribe without the balance',
    { balance: 0.01, mode: null, cards: upcoming, eligibility: 1 },
    card(102, true)
  ],
  [
    'subscribe a released card',
    { balance: 0.5, mode: null, cards: [], eligibility: 1 },
    card(RELEASED, true)
  ],
  [
    'a count within the eligibility',
    { balance: 0.5, mode: null, cards: upcoming, eligibility: 3 },
    count(104, 3)
  ],
  [
    'a count over the eligibility',
    { balance: 0.5, mode: null, cards: upcoming, eligibility: 2 },
    count(104, 3)
  ],
  [
    'a count on an unsubscribed card',
    { balance: 0.5, mode: null, cards: upcoming, eligibility: 3 },
    count(102, 2)
  ],
  [
    'a count without the balance',
    { balance: 0.1, mode: null, cards: upcoming, eligibility: 3 },
    count(103, 2)
  ],
  [
    'a count for a released card',
    { balance: 0.5, mode: null, cards: [], eligibility: 3 },
    count(RELEASED, 1)
  ]
];

beforeAll(async () => {
  await connect(
    Object.values(Entities).filter((e) => typeof e === 'function') as never
  );
});

afterAll(async () => {
  await disconnect();
});

describeWithSeed('identity choices against the legacy writes', [], () => {
  it.each(cases)('%s', async (_name, seed, change) => {
    await seedBoth(seed);
    const legacy = await outcome(legacyChange(change));
    const identity = await outcome(identityChange(change));
    expect(identity).toEqual(legacy);
    expect(await stateOf('identity')).toEqual(await stateOf('legacy'));
  });

  it('turns automatic mode on for a first top-up as the legacy mode change does, all editions on', async () => {
    await seedBoth({
      balance: 0.5,
      mode: { automatic: false, all: true },
      cards: upcoming,
      eligibility: 3
    });
    let logIds: number[] = [];
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await updateSubscriptionMode(W, true, connection);
      logIds = await turnIdentityAutomaticOn({
        identityKey: W,
        consolidationKey: W,
        atText: msToDbText(Date.now()),
        options: { wrappedConnection: connection }
      });
    });
    const identity = await stateOf('identity');
    expect(identity).toEqual(await stateOf('legacy'));
    expect(identity.cards).toEqual([
      [102, 1, 1, 0, 'moved'],
      [103, 1, 3, 1, 'kept'],
      [104, 1, 2, 0, 'kept']
    ]);
    // The ids of the lines it wrote, for the top-up's journal entry.
    const written = await sqlExecutor.execute<{ id: number }>(
      `SELECT id FROM ${SUBSCRIPTIONS_ID_LOGS_TABLE} WHERE identity_key = :w ORDER BY id`,
      { w: W }
    );
    expect(logIds).toEqual(written.map((row) => Number(row.id)));
    expect(logIds).toHaveLength(2);
  });
});
