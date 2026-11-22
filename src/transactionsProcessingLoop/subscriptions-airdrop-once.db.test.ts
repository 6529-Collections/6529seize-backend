import 'reflect-metadata';
import * as db from '@/db';
import * as Entities from '@/entities/entities';
import {
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
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { redeemSubscriptions } from './subscriptions';

jest.mock('@/subscription-wave-notifier', () => ({
  sendInsufficientBalanceWaveError: jest.fn(),
  sendNoBalanceFoundWaveError: jest.fn(),
  sendNoSubscriptionFoundWaveWarning: jest.fn()
}));

// Obviously fake wallets and hashes.
const WALLET = '0x00000000000000000000000000000000000000a1';
const SELLER = '0x00000000000000000000000000000000000000b2';
const CARD = 600;
const FIRST = '0x' + '1'.repeat(64);
const SECOND = '0x' + '2'.repeat(64);
const THIRD = '0x' + '3'.repeat(64);
const MEMES_SALE = '0x' + '5'.repeat(64);
const GRADIENTS_SALE = '0x' + '6'.repeat(64);

/**
 * Airdrops charged more times than the transaction delivered tokens to
 * that wallet: the same question the PR text asks of production.
 */
const DOUBLE_CHARGED_AIRDROPS = `
  SELECT r.transaction, r.contract, r.token_id, r.address,
         SUM(r.count) AS charged, MAX(t.token_count) AS airdropped,
         GROUP_CONCAT(DISTINCT r.consolidation_key) AS subscribers
    FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} r
    JOIN ${TRANSACTIONS_TABLE} t
      ON t.transaction = r.transaction AND t.contract = r.contract
     AND t.token_id = r.token_id AND LOWER(t.to_address) = LOWER(r.address)
     AND t.from_address = '${NULL_ADDRESS}'
   GROUP BY r.transaction, r.contract, r.token_id, r.address
  HAVING SUM(r.count) > MAX(t.token_count)`;

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
      // The transactions loop commits the second airdrop, in a later block,
      // just after this run has read the highest block.
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
      expect(await sqlExecutor.execute(DOUBLE_CHARGED_AIRDROPS)).toEqual([]);
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
    });

    it('finds an airdrop charged more times than it delivered tokens', async () => {
      await airdrop(FIRST, 101);
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTIONS_REDEEMED_TABLE}
          (consolidation_key, contract, token_id, address, \`transaction\`,
           transaction_date, value, balance_after, count)
          VALUES (:key, :contract, :card, :key, :hash, '2026-11-26 15:00:00',
           :value, 0.8, 2)`,
        {
          key: WALLET,
          contract: MEMES_CONTRACT,
          card: CARD,
          hash: FIRST,
          value: 2 * MEMES_MINT_PRICE
        }
      );
      const found = await sqlExecutor.execute<{
        transaction: string;
        charged: number;
        airdropped: number;
        subscribers: string;
      }>(DOUBLE_CHARGED_AIRDROPS);
      expect(
        found.map((r) => [
          r.transaction,
          Number(r.charged),
          Number(r.airdropped),
          r.subscribers
        ])
      ).toEqual([[FIRST, 2, 1, WALLET]]);
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
    });
  }
);
