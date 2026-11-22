import 'reflect-metadata';
import * as db from '@/db';
import * as Entities from '@/entities/entities';
import {
  DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES,
  DISTRIBUTION_PHASE_AIRDROP,
  DISTRIBUTION_PHASE_AIRDROP_ARTIST
} from '@/airdrop-phases';
import {
  DISTRIBUTION_TABLE,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { Transaction } from '@/entities/ITransaction';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { processAirdrop, redeemSubscriptions } from './subscriptions';

jest.mock('@/subscription-wave-notifier', () => ({
  sendInsufficientBalanceWaveError: jest.fn(),
  sendNoBalanceFoundWaveError: jest.fn(),
  sendNoSubscriptionFoundWaveWarning: jest.fn()
}));

// Obviously fake wallets and hashes.
const WALLET = '0x00000000000000000000000000000000000000a1';
const SELLER = '0x00000000000000000000000000000000000000b2';
const OTHER_KEY = '0x00000000000000000000000000000000000000c3';
const CARD = 600;
const FIRST = '0x' + '1'.repeat(64);
const SECOND = '0x' + '2'.repeat(64);
const THIRD = '0x' + '3'.repeat(64);
const MEMES_SALE = '0x' + '5'.repeat(64);
const GRADIENTS_SALE = '0x' + '6'.repeat(64);

const MEMES = MEMES_CONTRACT.toLowerCase();
const AIRDROP_PHASES = DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES.map(
  (phase) => `'${phase.toLowerCase()}'`
).join(', ');

/**
 * The queries the PR text gives for finding past wrong charges, with the
 * table names and addresses filled in from the constants. Both share these
 * steps: the memes airdrops the loop has processed, each with the tokens of
 * that card the wallet got from the null address in lower blocks, and the
 * free distribution-airdrop tokens of each card and wallet.
 */
const AIRDROP_STEPS = `
  WITH airdrops AS (
    SELECT t.transaction, t.block, t.token_id, LOWER(t.to_address) AS wallet,
           t.token_count,
           COALESCE(SUM(t.token_count) OVER (
             PARTITION BY t.token_id, LOWER(t.to_address)
             ORDER BY t.block
             RANGE BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS earlier
      FROM ${TRANSACTIONS_TABLE} t
     WHERE t.contract = '${MEMES}'
       AND t.from_address = '${NULL_ADDRESS}'
       AND t.value = 0
       AND t.token_count > 0
       AND t.block <= (SELECT MAX(block)
                         FROM ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE})
  ),
  free_airdrops AS (
    SELECT card_id AS token_id, LOWER(wallet) AS wallet, SUM(count) AS tokens
      FROM ${DISTRIBUTION_TABLE}
     WHERE LOWER(contract) = '${MEMES}'
       AND LOWER(phase) IN (${AIRDROP_PHASES})
     GROUP BY card_id, LOWER(wallet)
  )`;

/**
 * Per subscriber, card and airdrop wallet: the charges the loop recorded
 * against the charges due. The loop fills a wallet's editions in phase
 * order, so the charges due are the first editions in that order, one per
 * subscription token the wallet received.
 */
const WRONG_CHARGES = `${AIRDROP_STEPS},
  received AS (
    SELECT a.token_id, a.wallet, SUM(a.token_count) AS tokens
      FROM airdrops a
      LEFT JOIN free_airdrops f
        ON f.token_id = a.token_id AND f.wallet = a.wallet
     WHERE COALESCE(f.tokens, 0) < a.earlier + a.token_count
     GROUP BY a.token_id, a.wallet
  ),
  editions AS (
    SELECT s.consolidation_key, s.token_id,
           LOWER(s.airdrop_address) AS wallet, s.subscribed_count,
           COALESCE(SUM(s.subscribed_count) OVER (
             PARTITION BY s.token_id, LOWER(s.airdrop_address)
             ORDER BY s.phase, s.phase_position, s.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS ahead
      FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} s
     WHERE s.contract = '${MEMES}'
  ),
  charged AS (
    SELECT consolidation_key, token_id, LOWER(address) AS wallet,
           SUM(count) AS charges
      FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}
     WHERE contract = '${MEMES}'
     GROUP BY consolidation_key, token_id, LOWER(address)
  )
  SELECT k.*, k.charged - k.due AS difference FROM (
    SELECT e.token_id, e.wallet, e.consolidation_key,
           COALESCE(r.tokens, 0) AS received,
           e.subscribed_count AS editions,
           GREATEST(0, LEAST(e.subscribed_count,
                             COALESCE(r.tokens, 0) - e.ahead)) AS due,
           COALESCE(c.charges, 0) AS charged
      FROM editions e
      LEFT JOIN received r
        ON r.token_id = e.token_id AND r.wallet = e.wallet
      LEFT JOIN charged c
        ON c.consolidation_key = e.consolidation_key
       AND c.token_id = e.token_id AND c.wallet = e.wallet
  ) k
  WHERE charged <> due
  ORDER BY token_id, wallet, consolidation_key`;

/**
 * Per airdrop to a subscribed wallet: the cases to check. A subscription
 * airdrop whose charges differ from its tokens, or a distribution airdrop
 * that was charged.
 */
const AIRDROPS_TO_CHECK = `${AIRDROP_STEPS}
  SELECT * FROM (
    SELECT a.transaction, a.block, a.token_id, a.wallet,
           a.token_count AS tokens,
           COALESCE(f.tokens, 0) >= a.earlier + a.token_count
             AS is_distribution,
           (SELECT COALESCE(SUM(r.count), 0)
              FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} r
             WHERE r.transaction = a.transaction AND r.contract = '${MEMES}'
               AND r.token_id = a.token_id
               AND LOWER(r.address) = a.wallet) AS charged
      FROM airdrops a
      LEFT JOIN free_airdrops f
        ON f.token_id = a.token_id AND f.wallet = a.wallet
     WHERE EXISTS (SELECT 1 FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} s
                    WHERE s.contract = '${MEMES}' AND s.token_id = a.token_id
                      AND LOWER(s.airdrop_address) = a.wallet)
  ) x
  WHERE charged <> IF(is_distribution, 0, tokens)
  ORDER BY token_id, wallet, block`;

function transfer(
  hash: string,
  block: number,
  opts: { from?: string; contract?: string; value?: number } = {}
) {
  return sqlExecutor.execute(
    `INSERT INTO ${TRANSACTIONS_TABLE}
      (created_at, transaction, block, transaction_date, from_address, to_address,
       contract, token_id, token_count, value, primary_proceeds, royalties,
       gas_gwei, gas_price, gas_price_gwei, gas)
      VALUES (NOW(), :hash, :block, '2026-11-26 15:00:00', :from, :to, :contract,
       :card, 1, :value, 0, 0, 0, 0, 0, 0)`,
    {
      hash,
      block,
      from: opts.from ?? NULL_ADDRESS,
      to: WALLET,
      contract: (opts.contract ?? MEMES_CONTRACT).toLowerCase(),
      card: CARD,
      value: opts.value ?? 0
    }
  );
}

function airdrop(hash: string, block: number) {
  return transfer(hash, block);
}

function subscribe(key: string, editions: number, position: number) {
  return sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
      (consolidation_key, contract, token_id, subscribed_count, airdrop_address,
       balance, subscribed_at, phase, phase_subscriptions, phase_position,
       redeemed_count)
      VALUES (:key, :contract, :card, :editions, :wallet, 1,
       '2026-11-20 00:00:00', 'Phase 1', 2, :position, 0)`,
    {
      key,
      contract: MEMES_CONTRACT,
      card: CARD,
      editions,
      wallet: WALLET,
      position
    }
  );
}

function distribute(phase: string) {
  return sqlExecutor.execute(
    `INSERT INTO ${DISTRIBUTION_TABLE}
      (created_at, updated_at, card_id, contract, phase, wallet, count)
      VALUES (NOW(), NOW(), :card, :contract, :phase, :wallet, 1)`,
    { card: CARD, contract: MEMES_CONTRACT, phase, wallet: WALLET }
  );
}

/** What the next run did before the fix: charge the airdrop once more. */
async function chargeAgain(hash: string) {
  const [drop] = await sqlExecutor.execute<Transaction>(
    `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE transaction = :hash`,
    { hash }
  );
  await db
    .getDataSource()
    .transaction((manager) => processAirdrop(drop, manager));
}

/** A charge the loop made before the string-sum fix, written by hand. */
function chargedByHand(hash: string, key: string) {
  return sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_REDEEMED_TABLE}
      (consolidation_key, contract, token_id, address, \`transaction\`,
       transaction_date, value, balance_after, count)
      VALUES (:key, :contract, :card, :wallet, :hash, '2026-11-26 15:00:00',
       :value, 0, 1)`,
    {
      key,
      contract: MEMES,
      card: CARD,
      wallet: WALLET,
      hash,
      value: MEMES_MINT_PRICE
    }
  );
}

async function charges() {
  const rows = await sqlExecutor.execute<{
    transaction: string;
    count: number;
  }>(
    `SELECT \`transaction\`, count FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} ORDER BY \`transaction\``
  );
  const [balance] = await sqlExecutor.execute<{ balance: number }>(
    `SELECT balance FROM ${SUBSCRIPTIONS_BALANCES_TABLE} WHERE consolidation_key = :key`,
    { key: WALLET }
  );
  return {
    perTransaction: rows.map((r) => [r.transaction, Number(r.count)]),
    balance: Number(balance.balance)
  };
}

/** [key, received, editions, due, charged, difference] per row. */
async function wrongCharges() {
  const rows = await sqlExecutor.execute<Record<string, string>>(WRONG_CHARGES);
  return rows.map((r) => [
    r.consolidation_key,
    Number(r.received),
    Number(r.editions),
    Number(r.due),
    Number(r.charged),
    Number(r.difference)
  ]);
}

/** [transaction, tokens, is_distribution, charged] per row. */
async function airdropsToCheck() {
  const rows =
    await sqlExecutor.execute<Record<string, string>>(AIRDROPS_TO_CHECK);
  return rows.map((r) => [
    r.transaction,
    Number(r.tokens),
    Number(r.is_distribution),
    Number(r.charged)
  ]);
}

beforeAll(async () => {
  expect(process.env.DB_HOST).toMatch(/^(localhost|127\.0\.0\.1)$/);
  await db.connect(
    Object.values(Entities).filter((e) => typeof e === 'function') as never,
    false,
    { database: process.env.DB_NAME!, failOnInitializationError: true }
  );
});

afterAll(async () => {
  if (db.getDataSource()?.isInitialized) await db.disconnect();
});

describeWithSeed(
  'legacy airdrop redemption',
  [
    {
      table: TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
      rows: [{ created_at: new Date(), block: 100, timestamp: 0 }]
    },
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [{ consolidation_key: WALLET, balance: 1 }]
    },
    {
      // Three editions subscribed, so a slot is still free after each charge.
      table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      rows: [
        {
          consolidation_key: WALLET,
          contract: MEMES_CONTRACT,
          token_id: CARD,
          subscribed_count: 3,
          airdrop_address: WALLET,
          balance: 1,
          subscribed_at: '2026-11-20 00:00:00',
          phase: 'Phase 1',
          phase_subscriptions: 1,
          phase_position: 1,
          redeemed_count: 0
        }
      ]
    }
  ],
  () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('charges an airdrop committed between its two reads once, across two runs', async () => {
      await airdrop(FIRST, 101);
      // The memes loop commits the second airdrop, in a later block, just
      // after this run has read the highest block.
      const readMax = db.fetchMaxTransactionByBlockNumber;
      jest
        .spyOn(db, 'fetchMaxTransactionByBlockNumber')
        .mockImplementationOnce(async (contract) => {
          const max = await readMax(contract);
          await airdrop(SECOND, 102);
          return max;
        });
      await redeemSubscriptions();
      await redeemSubscriptions();

      const after = await charges();
      expect(after.perTransaction).toEqual([
        [FIRST, 1],
        [SECOND, 1]
      ]);
      expect(after.balance).toBeCloseTo(1 - 2 * MEMES_MINT_PRICE, 10);
      expect(await wrongCharges()).toEqual([]);
      expect(await airdropsToCheck()).toEqual([]);
    });

    it('charges a memes airdrop committed after another contract reached a higher block', async () => {
      // A memes sale at the cursor, and a gradients sale the gradients loop
      // has already committed in block 105.
      await transfer(MEMES_SALE, 100, { from: SELLER, value: 0.1 });
      await transfer(GRADIENTS_SALE, 105, {
        from: SELLER,
        contract: GRADIENT_CONTRACT,
        value: 0.1
      });
      await redeemSubscriptions();
      // The memes loop then commits an airdrop in block 103.
      await airdrop(FIRST, 103);
      await redeemSubscriptions();
      await redeemSubscriptions();

      const after = await charges();
      expect(after.perTransaction).toEqual([[FIRST, 1]]);
      expect(after.balance).toBeCloseTo(1 - MEMES_MINT_PRICE, 10);
      expect(await wrongCharges()).toEqual([]);
    });
  }
);

describeWithSeed(
  'legacy airdrop redemption: distribution airdrops',
  [
    {
      table: TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
      rows: [{ created_at: new Date(), block: 100, timestamp: 0 }]
    },
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [{ consolidation_key: WALLET, balance: 1 }]
    },
    {
      // The wallet is on two airdrop phases of the card: two free tokens.
      table: DISTRIBUTION_TABLE,
      rows: [DISTRIBUTION_PHASE_AIRDROP, DISTRIBUTION_PHASE_AIRDROP_ARTIST].map(
        (phase) => ({
          created_at: new Date(),
          updated_at: new Date(),
          card_id: CARD,
          contract: MEMES_CONTRACT,
          phase,
          wallet: WALLET,
          count: 1
        })
      )
    },
    {
      // It also subscribed to one edition.
      table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      rows: [
        {
          consolidation_key: WALLET,
          contract: MEMES_CONTRACT,
          token_id: CARD,
          subscribed_count: 1,
          airdrop_address: WALLET,
          balance: 1,
          subscribed_at: '2026-11-20 00:00:00',
          phase: 'Phase 1',
          phase_subscriptions: 1,
          phase_position: 1,
          redeemed_count: 0
        }
      ]
    }
  ],
  () => {
    it('charges neither distribution airdrop when they come in two transactions', async () => {
      await airdrop(FIRST, 101);
      await airdrop(SECOND, 102);
      await airdrop(THIRD, 103);
      await redeemSubscriptions();

      // Only the third, the subscription airdrop, is charged. Before the fix
      // the second was charged and took the edition the third needed.
      const after = await charges();
      expect(after.perTransaction).toEqual([[THIRD, 1]]);
      expect(after.balance).toBeCloseTo(1 - MEMES_MINT_PRICE, 10);
      expect(await wrongCharges()).toEqual([]);
    });
  }
);

// Each test leaves the tables as the loop did before these fixes, using the
// loop's own code where it can, and checks what the two queries report.
describeWithSeed(
  'queries for past wrong charges',
  [
    {
      table: TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
      rows: [{ created_at: new Date(), block: 100, timestamp: 0 }]
    },
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [
        { consolidation_key: WALLET, balance: 1 },
        { consolidation_key: OTHER_KEY, balance: 1 }
      ]
    }
  ],
  () => {
    it('reports nothing to put right when the extra charge used the edition a later airdrop needed', async () => {
      await subscribe(WALLET, 2, 1);
      await airdrop(FIRST, 101);
      await redeemSubscriptions();
      await chargeAgain(FIRST);
      await airdrop(SECOND, 102);
      await redeemSubscriptions();

      // Two tokens received, two charged: the right total.
      const after = await charges();
      expect(after.perTransaction).toEqual([[FIRST, 2]]);
      expect(after.balance).toBeCloseTo(1 - 2 * MEMES_MINT_PRICE, 10);
      expect(await wrongCharges()).toEqual([]);
      // Both airdrops are still cases to check.
      expect(await airdropsToCheck()).toEqual([
        [FIRST, 1, 0, 2],
        [SECOND, 1, 0, 0]
      ]);
    });

    it('reports one extra charge when the subscriber had an edition to spare', async () => {
      await subscribe(WALLET, 3, 1);
      await airdrop(FIRST, 101);
      await redeemSubscriptions();
      await chargeAgain(FIRST);
      await airdrop(SECOND, 102);
      await redeemSubscriptions();

      expect(await wrongCharges()).toEqual([[WALLET, 2, 3, 2, 3, 1]]);
      expect(await airdropsToCheck()).toEqual([[FIRST, 1, 0, 2]]);
    });

    it('puts the extra charge on the subscriber holding the last edition charged', async () => {
      // Two subscribers share the airdrop wallet; WALLET comes first.
      await subscribe(WALLET, 1, 1);
      await subscribe(OTHER_KEY, 2, 2);
      await airdrop(FIRST, 101);
      await airdrop(SECOND, 102);
      await redeemSubscriptions();
      // The second airdrop went to OTHER_KEY, and so did its extra charge.
      await chargeAgain(SECOND);

      expect(await wrongCharges()).toEqual([[OTHER_KEY, 2, 2, 1, 2, 1]]);
      expect(await airdropsToCheck()).toEqual([[SECOND, 1, 0, 2]]);
    });

    it('reports an airdrop left behind the cursor as a missed charge', async () => {
      await subscribe(WALLET, 2, 1);
      await airdrop(FIRST, 101);
      await redeemSubscriptions();
      // Committed in a block the cursor had already passed.
      await airdrop(SECOND, 101);
      await redeemSubscriptions();

      expect(await wrongCharges()).toEqual([[WALLET, 2, 2, 2, 1, -1]]);
      expect(await airdropsToCheck()).toEqual([[SECOND, 1, 0, 0]]);
    });

    it('does not count distribution airdrops as received, and reports one that was charged', async () => {
      await subscribe(WALLET, 2, 1);
      await distribute(DISTRIBUTION_PHASE_AIRDROP);
      await distribute(DISTRIBUTION_PHASE_AIRDROP_ARTIST);
      await airdrop(FIRST, 101);
      await airdrop(SECOND, 102);
      await airdrop(THIRD, 103);
      await redeemSubscriptions();
      // Before the string-sum fix the loop also charged the second.
      await chargedByHand(SECOND, WALLET);

      // One subscription token received, two charges.
      expect(await wrongCharges()).toEqual([[WALLET, 1, 2, 1, 2, 1]]);
      expect(await airdropsToCheck()).toEqual([[SECOND, 1, 1, 1]]);
    });
  }
);
