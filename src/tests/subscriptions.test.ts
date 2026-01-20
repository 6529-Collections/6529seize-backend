import { when } from 'jest-when';
import { Mock, mock } from 'ts-jest-mocker';
import { EntityManager, Repository } from 'typeorm';
import {
  DISTRIBUTION_TABLE,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  RESEARCH_6529_ADDRESS,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  TRANSACTIONS_TABLE
} from '../constants';
import {
  NFTFinalSubscription,
  RedeemedSubscription,
  SubscriptionBalance
} from '../entities/ISubscription';
import { Transaction } from '../entities/ITransaction';
import {
  processAirdrop,
  validateNonSubscriptionAirdrop
} from '../transactionsProcessingLoop/subscriptions';
import {
  buildTransaction,
  generateRandomTokenId
} from './test.transactions.helpers';
import { Env } from '../env';

jest.mock('../notifier-discord', () => ({
  sendDiscordUpdate: jest.fn()
}));

jest.mock('../subscriptionsDaily/db.subscriptions', () => ({
  fetchSubscriptionBalanceForConsolidationKey: jest.fn()
}));

const { sendDiscordUpdate: mockSendDiscordUpdate } = jest.requireMock(
  '../notifier-discord'
);
const { fetchSubscriptionBalanceForConsolidationKey: mockFetchBalance } =
  jest.requireMock('../subscriptionsDaily/db.subscriptions');

describe('SubscriptionTests', () => {
  let entityManager: Mock<EntityManager>;
  let subscriptionBalanceRepo: Mock<Repository<SubscriptionBalance>>;
  let redeemedSubscriptionRepo: Mock<Repository<RedeemedSubscription>>;
  let nftFinalSubscriptionRepo: Mock<Repository<NFTFinalSubscription>>;
  let env: Mock<Env>;

  beforeEach(() => {
    entityManager = mock(EntityManager);
    subscriptionBalanceRepo = mock(Repository) as any;
    redeemedSubscriptionRepo = mock(Repository) as any;
    nftFinalSubscriptionRepo = mock(Repository) as any;
    env = mock(Env) as any;

    entityManager.getRepository = jest.fn((entity: any) => {
      if (entity === SubscriptionBalance) {
        return subscriptionBalanceRepo;
      }
      if (entity === RedeemedSubscription) {
        return redeemedSubscriptionRepo;
      }
      if (entity === NFTFinalSubscription) {
        return nftFinalSubscriptionRepo;
      }
      return mock(Repository);
    }) as any;

    env.getStringOrThrow = jest.fn((str: string) => {
      return 'test';
    });

    jest.clearAllMocks();
  });

  describe('validateNonSubscriptionAirdrop', () => {
    it('not memes contract', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        GRADIENT_CONTRACT,
        generateRandomTokenId()
      );
      const response = await validateNonSubscriptionAirdrop(
        transaction,
        entityManager
      );
      expect(response).toEqual({
        valid: true,
        message: 'Not memes contract'
      });
      expect(entityManager.query).not.toHaveBeenCalled();
    });

    it('airdrop to research', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        RESEARCH_6529_ADDRESS,
        MEMES_CONTRACT,
        generateRandomTokenId()
      );
      const response = await validateNonSubscriptionAirdrop(
        transaction,
        entityManager
      );
      expect(response).toEqual({
        valid: true,
        message: 'Airdrop to research'
      });
      expect(entityManager.query).not.toHaveBeenCalled();
    });

    it('in initial airdrop', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId()
      );
      whenRequestDistribution(entityManager, transaction, { count: 1 });
      whenRequestAirdrops(entityManager, transaction, 0);
      const response = await validateNonSubscriptionAirdrop(
        transaction,
        entityManager
      );
      expect(response).toEqual({
        valid: true,
        message: 'Distribution airdrop'
      });
      expect(entityManager.query).toHaveBeenCalledTimes(2);
    });

    it('in initial airdrop 2', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId()
      );
      whenRequestDistribution(entityManager, transaction, { count: 2 });
      whenRequestAirdrops(entityManager, transaction, 1);
      const response = await validateNonSubscriptionAirdrop(
        transaction,
        entityManager
      );
      expect(response).toEqual({
        valid: true,
        message: 'Distribution airdrop'
      });
      expect(entityManager.query).toHaveBeenCalledTimes(2);
    });

    it('not in initial airdrop', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId()
      );
      whenRequestDistribution(entityManager, transaction, undefined);
      const response = await validateNonSubscriptionAirdrop(
        transaction,
        entityManager
      );
      const { sql: adSql, params: adParams } = getAirdropSql(transaction);
      expect(response).toEqual({
        valid: false,
        message: 'Subscription airdrop'
      });
      expect(entityManager.query).not.toHaveBeenCalledWith(adSql, adParams);
      expect(entityManager.query).toHaveBeenCalledTimes(1);
    });

    it('in initial airdrop and in phase airdrop', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId()
      );
      whenRequestDistribution(entityManager, transaction, { count: 1 });
      whenRequestAirdrops(entityManager, transaction, 1);
      const response = await validateNonSubscriptionAirdrop(
        transaction,
        entityManager
      );
      expect(response).toEqual({
        valid: false,
        message: 'Subscription airdrop'
      });
      expect(entityManager.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('processAirdrop', () => {
    it('user subscribed for 1, gets token_count 1 - success case, balance deducted, 1x redeemed subscription', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId(),
        1
      );
      const consolidationKey = 'consolidation-key-123';
      const initialBalance = MEMES_MINT_PRICE * 2;

      let currentBalance = initialBalance;
      mockFetchBalance.mockImplementation(() =>
        Promise.resolve({
          consolidation_key: consolidationKey,
          balance: currentBalance
        })
      );
      subscriptionBalanceRepo.save.mockImplementation((balance: any) => {
        currentBalance = balance.balance;
        return Promise.resolve(balance);
      });

      whenRequestDistribution(entityManager, transaction, undefined);
      whenRequestSubscription(
        entityManager,
        transaction,
        buildSubscription(
          consolidationKey,
          transaction.contract,
          transaction.token_id,
          transaction.to_address,
          1,
          0
        ),
        1
      );
      redeemedSubscriptionRepo.findOne.mockResolvedValue(null);
      let savedRedeemed: RedeemedSubscription | null = null;
      redeemedSubscriptionRepo.save.mockImplementation((record: any) => {
        savedRedeemed = record;
        return Promise.resolve(record);
      });
      redeemedSubscriptionRepo.findOne.mockImplementation(() => {
        return Promise.resolve(savedRedeemed);
      });
      nftFinalSubscriptionRepo.save.mockResolvedValue({} as any);

      await processAirdrop(transaction, entityManager, env);

      expect(mockFetchBalance).toHaveBeenCalledTimes(1);
      expect(subscriptionBalanceRepo.save).toHaveBeenCalledTimes(1);
      expect(redeemedSubscriptionRepo.findOne).toHaveBeenCalledTimes(1);
      expect(redeemedSubscriptionRepo.save).toHaveBeenCalledTimes(1);
      expect(nftFinalSubscriptionRepo.save).toHaveBeenCalledTimes(1);

      const balanceSave = subscriptionBalanceRepo.save.mock.calls[0][0];
      expect(balanceSave.balance).toBe(
        Math.round((initialBalance - MEMES_MINT_PRICE) * 100000) / 100000
      );

      const redeemedSave = redeemedSubscriptionRepo.save.mock.calls[0][0];
      expect(redeemedSave.consolidation_key).toBe(consolidationKey);
      expect(redeemedSave.value).toBe(MEMES_MINT_PRICE);
      expect(redeemedSave.count).toBe(1);
      expect(redeemedSave.contract).toBe(transaction.contract);
      expect(redeemedSave.token_id).toBe(transaction.token_id);

      const subscriptionSave = nftFinalSubscriptionRepo.save.mock.calls[0][0];
      expect(subscriptionSave.redeemed_count).toBe(1);
    });

    it('user subscribed for 3, gets token_count 3 - success case, all balance deducted, 3x redeemed subscriptions', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId(),
        3
      );
      const consolidationKey = 'consolidation-key-123';
      const initialBalance = MEMES_MINT_PRICE * 5;

      let currentBalance = initialBalance;
      mockFetchBalance.mockImplementation(() =>
        Promise.resolve({
          consolidation_key: consolidationKey,
          balance: currentBalance
        })
      );
      subscriptionBalanceRepo.save.mockImplementation((balance: any) => {
        currentBalance = balance.balance;
        return Promise.resolve(balance);
      });

      whenRequestDistribution(entityManager, transaction, undefined);
      whenRequestSubscription(
        entityManager,
        transaction,
        buildSubscription(
          consolidationKey,
          transaction.contract,
          transaction.token_id,
          transaction.to_address,
          3,
          0
        ),
        3
      );
      let savedRedeemed: RedeemedSubscription | null = null;
      redeemedSubscriptionRepo.findOne
        .mockResolvedValueOnce(null)
        .mockImplementation(() => Promise.resolve(savedRedeemed));
      redeemedSubscriptionRepo.save.mockImplementation((record: any) => {
        savedRedeemed = { ...record };
        return Promise.resolve(record);
      });
      nftFinalSubscriptionRepo.save.mockResolvedValue({} as any);

      await processAirdrop(transaction, entityManager, env);

      expect(mockFetchBalance).toHaveBeenCalledTimes(3);
      expect(subscriptionBalanceRepo.save).toHaveBeenCalledTimes(3);
      expect(redeemedSubscriptionRepo.findOne).toHaveBeenCalledTimes(3);
      expect(redeemedSubscriptionRepo.save).toHaveBeenCalledTimes(3);
      expect(nftFinalSubscriptionRepo.save).toHaveBeenCalledTimes(3);

      const balanceSaves = subscriptionBalanceRepo.save.mock.calls;
      expect(balanceSaves[0][0].balance).toBe(
        Math.round((initialBalance - MEMES_MINT_PRICE) * 100000) / 100000
      );
      expect(balanceSaves[1][0].balance).toBe(
        Math.round((initialBalance - MEMES_MINT_PRICE * 2) * 100000) / 100000
      );
      expect(balanceSaves[2][0].balance).toBe(
        Math.round((initialBalance - MEMES_MINT_PRICE * 3) * 100000) / 100000
      );

      const redeemedSaves = redeemedSubscriptionRepo.save.mock.calls;
      expect(redeemedSaves).toHaveLength(3);
      expect(redeemedSaves[0][0].consolidation_key).toBe(consolidationKey);
      expect(redeemedSaves[0][0].value).toBe(MEMES_MINT_PRICE);
      expect(redeemedSaves[0][0].count).toBe(1);
      expect(redeemedSaves[1][0].consolidation_key).toBe(consolidationKey);
      expect(redeemedSaves[1][0].value).toBe(MEMES_MINT_PRICE * 2);
      expect(redeemedSaves[1][0].count).toBe(2);
      expect(redeemedSaves[2][0].consolidation_key).toBe(consolidationKey);
      expect(redeemedSaves[2][0].value).toBe(MEMES_MINT_PRICE * 3);
      expect(redeemedSaves[2][0].count).toBe(3);
      redeemedSaves.forEach((call) => {
        expect(call[0].contract).toBe(transaction.contract);
        expect(call[0].token_id).toBe(transaction.token_id);
      });

      const subscriptionSaves = nftFinalSubscriptionRepo.save.mock.calls;
      expect(subscriptionSaves[0][0].redeemed_count).toBe(1);
      expect(subscriptionSaves[1][0].redeemed_count).toBe(2);
      expect(subscriptionSaves[2][0].redeemed_count).toBe(3);
    });

    it('user subscribed for 3, gets token_count 2 - success, 2x mint price deducted, 2x redeemed', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId(),
        2
      );
      const consolidationKey = 'consolidation-key-123';
      const initialBalance = MEMES_MINT_PRICE * 5;

      let currentBalance = initialBalance;
      mockFetchBalance.mockImplementation(() =>
        Promise.resolve({
          consolidation_key: consolidationKey,
          balance: currentBalance
        })
      );
      subscriptionBalanceRepo.save.mockImplementation((balance: any) => {
        currentBalance = balance.balance;
        return Promise.resolve(balance);
      });

      whenRequestDistribution(entityManager, transaction, undefined);
      whenRequestSubscription(
        entityManager,
        transaction,
        buildSubscription(
          consolidationKey,
          transaction.contract,
          transaction.token_id,
          transaction.to_address,
          3,
          0
        ),
        2
      );
      let savedRedeemed: RedeemedSubscription | null = null;
      redeemedSubscriptionRepo.findOne
        .mockResolvedValueOnce(null)
        .mockImplementation(() => Promise.resolve(savedRedeemed));
      redeemedSubscriptionRepo.save.mockImplementation((record: any) => {
        savedRedeemed = { ...record };
        return Promise.resolve(record);
      });
      nftFinalSubscriptionRepo.save.mockResolvedValue({} as any);

      await processAirdrop(transaction, entityManager, env);

      expect(mockFetchBalance).toHaveBeenCalledTimes(2);
      expect(subscriptionBalanceRepo.save).toHaveBeenCalledTimes(2);
      expect(redeemedSubscriptionRepo.findOne).toHaveBeenCalledTimes(2);
      expect(redeemedSubscriptionRepo.save).toHaveBeenCalledTimes(2);
      expect(nftFinalSubscriptionRepo.save).toHaveBeenCalledTimes(2);

      const balanceSaves = subscriptionBalanceRepo.save.mock.calls;
      expect(balanceSaves[0][0].balance).toBe(
        Math.round((initialBalance - MEMES_MINT_PRICE) * 100000) / 100000
      );
      expect(balanceSaves[1][0].balance).toBe(
        Math.round((initialBalance - MEMES_MINT_PRICE * 2) * 100000) / 100000
      );

      const redeemedSaves = redeemedSubscriptionRepo.save.mock.calls;
      expect(redeemedSaves[0][0].count).toBe(1);
      expect(redeemedSaves[0][0].value).toBe(MEMES_MINT_PRICE);
      expect(redeemedSaves[1][0].count).toBe(2);
      expect(redeemedSaves[1][0].value).toBe(MEMES_MINT_PRICE * 2);

      const subscriptionSaves = nftFinalSubscriptionRepo.save.mock.calls;
      expect(subscriptionSaves[0][0].redeemed_count).toBe(1);
      expect(subscriptionSaves[1][0].redeemed_count).toBe(2);
    });

    it('user subscribed for 2, gets token_count 3 - should fail even if enough balance', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId(),
        3
      );
      const consolidationKey = 'consolidation-key-123';
      const initialBalance = MEMES_MINT_PRICE * 10;

      let currentBalance = initialBalance;
      mockFetchBalance.mockImplementation(() =>
        Promise.resolve({
          consolidation_key: consolidationKey,
          balance: currentBalance
        })
      );
      subscriptionBalanceRepo.save.mockImplementation((balance: any) => {
        currentBalance = balance.balance;
        return Promise.resolve(balance);
      });

      whenRequestDistribution(entityManager, transaction, undefined);
      whenRequestSubscription(
        entityManager,
        transaction,
        buildSubscription(
          consolidationKey,
          transaction.contract,
          transaction.token_id,
          transaction.to_address,
          2,
          0
        ),
        2
      );
      whenRequestSubscription(entityManager, transaction, undefined, 1);
      let savedRedeemed: RedeemedSubscription | null = null;
      redeemedSubscriptionRepo.findOne
        .mockResolvedValueOnce(null)
        .mockImplementation(() => Promise.resolve(savedRedeemed));
      redeemedSubscriptionRepo.save.mockImplementation((record: any) => {
        savedRedeemed = { ...record };
        return Promise.resolve(record);
      });
      nftFinalSubscriptionRepo.save.mockResolvedValue({} as any);

      await processAirdrop(transaction, entityManager, env);

      expect(mockFetchBalance).toHaveBeenCalledTimes(2);
      expect(subscriptionBalanceRepo.save).toHaveBeenCalledTimes(2);
      expect(redeemedSubscriptionRepo.findOne).toHaveBeenCalledTimes(2);
      expect(redeemedSubscriptionRepo.save).toHaveBeenCalledTimes(2);
      expect(nftFinalSubscriptionRepo.save).toHaveBeenCalledTimes(2);

      expect(mockSendDiscordUpdate).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('No subscription found'),
        'Subscriptions',
        'warn'
      );
    });

    it('user subscribed for 2, gets token_count 2 but not enough balance - should fail', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId(),
        2
      );
      const consolidationKey = 'consolidation-key-123';
      const initialBalance = MEMES_MINT_PRICE * 0.5;

      let currentBalance = initialBalance;
      mockFetchBalance.mockImplementation(() =>
        Promise.resolve({
          consolidation_key: consolidationKey,
          balance: currentBalance
        })
      );
      subscriptionBalanceRepo.save.mockImplementation((balance: any) => {
        currentBalance = balance.balance;
        return Promise.resolve(balance);
      });

      whenRequestDistribution(entityManager, transaction, undefined);
      whenRequestSubscription(
        entityManager,
        transaction,
        buildSubscription(
          consolidationKey,
          transaction.contract,
          transaction.token_id,
          transaction.to_address,
          2,
          0
        ),
        2
      );
      let savedRedeemed: RedeemedSubscription | null = null;
      redeemedSubscriptionRepo.findOne
        .mockResolvedValueOnce(null)
        .mockImplementation(() => Promise.resolve(savedRedeemed));
      redeemedSubscriptionRepo.save.mockImplementation((record: any) => {
        savedRedeemed = { ...record };
        return Promise.resolve(record);
      });
      nftFinalSubscriptionRepo.save.mockResolvedValue({} as any);

      await processAirdrop(transaction, entityManager, env);

      expect(mockFetchBalance).toHaveBeenCalledTimes(2);
      expect(mockSendDiscordUpdate).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Insufficient balance'),
        'Subscriptions',
        'error'
      );

      expect(subscriptionBalanceRepo.save).toHaveBeenCalledTimes(2);
      expect(redeemedSubscriptionRepo.findOne).toHaveBeenCalledTimes(2);
      expect(redeemedSubscriptionRepo.save).toHaveBeenCalledTimes(2);
      expect(nftFinalSubscriptionRepo.save).toHaveBeenCalledTimes(2);
    });

    it('user subscribed for 1, gets token_count 1 with no balance - should create balance with 0', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId(),
        1
      );
      const consolidationKey = 'consolidation-key-123';

      whenRequestDistribution(entityManager, transaction, undefined);
      whenRequestSubscription(
        entityManager,
        transaction,
        buildSubscription(
          consolidationKey,
          transaction.contract,
          transaction.token_id,
          transaction.to_address,
          1,
          0
        ),
        1
      );
      mockFetchBalance.mockResolvedValue(null);
      subscriptionBalanceRepo.save.mockResolvedValue({} as any);
      redeemedSubscriptionRepo.findOne.mockResolvedValue(null);
      redeemedSubscriptionRepo.save.mockResolvedValue({} as any);
      nftFinalSubscriptionRepo.save.mockResolvedValue({} as any);

      await processAirdrop(transaction, entityManager, env);

      expect(mockFetchBalance).toHaveBeenCalledTimes(1);
      expect(mockSendDiscordUpdate).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('No balance found'),
        'Subscriptions',
        'error'
      );

      expect(subscriptionBalanceRepo.save).toHaveBeenCalledTimes(1);
      const balanceSave = subscriptionBalanceRepo.save.mock.calls[0][0];
      expect(balanceSave.consolidation_key).toBe(consolidationKey);
      expect(balanceSave.balance).toBe(
        Math.round((0 - MEMES_MINT_PRICE) * 100000) / 100000
      );
    });

    it('user with multiple subscriptions processes them in order', async () => {
      const transaction = buildTransaction(
        NULL_ADDRESS,
        '0x123',
        MEMES_CONTRACT,
        generateRandomTokenId(),
        3
      );
      const consolidationKey1 = 'consolidation-key-1';
      const consolidationKey2 = 'consolidation-key-2';
      const initialBalance1 = MEMES_MINT_PRICE * 2;
      const initialBalance2 = MEMES_MINT_PRICE * 2;

      let currentBalance1 = initialBalance1;
      let currentBalance2 = initialBalance2;
      mockFetchBalance.mockImplementation((key: string) => {
        if (key === consolidationKey1) {
          return Promise.resolve({
            consolidation_key: consolidationKey1,
            balance: currentBalance1
          });
        } else {
          return Promise.resolve({
            consolidation_key: consolidationKey2,
            balance: currentBalance2
          });
        }
      });
      subscriptionBalanceRepo.save.mockImplementation((balance: any) => {
        if (balance.consolidation_key === consolidationKey1) {
          currentBalance1 = balance.balance;
        } else {
          currentBalance2 = balance.balance;
        }
        return Promise.resolve(balance);
      });

      whenRequestDistribution(entityManager, transaction, undefined);
      whenRequestSubscription(
        entityManager,
        transaction,
        buildSubscription(
          consolidationKey1,
          transaction.contract,
          transaction.token_id,
          transaction.to_address,
          2,
          0,
          'phase1',
          1
        ),
        2
      );
      whenRequestSubscription(
        entityManager,
        transaction,
        buildSubscription(
          consolidationKey2,
          transaction.contract,
          transaction.token_id,
          transaction.to_address,
          2,
          0,
          'phase1',
          2
        ),
        1
      );
      const savedRedeemedByKey = new Map<string, RedeemedSubscription>();
      redeemedSubscriptionRepo.findOne.mockImplementation((options: any) => {
        const key = options.where.consolidation_key;
        return Promise.resolve(savedRedeemedByKey.get(key) || null);
      });
      redeemedSubscriptionRepo.save.mockImplementation((record: any) => {
        savedRedeemedByKey.set(record.consolidation_key, { ...record });
        return Promise.resolve(record);
      });
      nftFinalSubscriptionRepo.save.mockResolvedValue({} as any);

      await processAirdrop(transaction, entityManager, env);

      expect(mockFetchBalance).toHaveBeenCalledTimes(3);
      expect(subscriptionBalanceRepo.save).toHaveBeenCalledTimes(3);
      expect(redeemedSubscriptionRepo.findOne).toHaveBeenCalledTimes(3);
      expect(redeemedSubscriptionRepo.save).toHaveBeenCalledTimes(3);
      expect(nftFinalSubscriptionRepo.save).toHaveBeenCalledTimes(3);

      const redeemedSaves = redeemedSubscriptionRepo.save.mock.calls;
      expect(redeemedSaves[0][0].consolidation_key).toBe(consolidationKey1);
      expect(redeemedSaves[0][0].count).toBe(1);
      expect(redeemedSaves[1][0].consolidation_key).toBe(consolidationKey1);
      expect(redeemedSaves[1][0].count).toBe(2);
      expect(redeemedSaves[2][0].consolidation_key).toBe(consolidationKey2);
      expect(redeemedSaves[2][0].count).toBe(1);
    });
  });
});

function getDistributionSql(transaction: Transaction) {
  return {
    sql: `SELECT * FROM ${DISTRIBUTION_TABLE} 
        WHERE LOWER(wallet) = ?
        AND LOWER(phase) = ?
        AND LOWER(contract) = ?
        AND card_id = ?;`,
    params: [
      transaction.to_address.toLowerCase(),
      'airdrop',
      transaction.contract.toLowerCase(),
      transaction.token_id
    ]
  };
}

function whenRequestDistribution(
  entityManager: Mock<EntityManager>,
  transaction: Transaction,
  response?: { count: number }
) {
  const { sql, params } = getDistributionSql(transaction);
  when(entityManager.query)
    .calledWith(sql, params)
    .mockResolvedValue([response]);
}

function getAirdropSql(transaction: Transaction) {
  return {
    sql: `SELECT SUM(token_count) as previous_airdrops FROM ${TRANSACTIONS_TABLE}
        WHERE contract = ?
        AND token_id = ?
        AND from_address = ?
        AND block < ?
        AND value = 0;`,
    params: [
      transaction.contract,
      transaction.token_id,
      NULL_ADDRESS,
      transaction.block
    ]
  };
}

function whenRequestAirdrops(
  entityManager: Mock<EntityManager>,
  transaction: Transaction,
  response: number
) {
  const { sql, params } = getAirdropSql(transaction);
  when(entityManager.query)
    .calledWith(sql, params)
    .mockResolvedValue([
      {
        previous_airdrops: response
      }
    ]);
}

function buildSubscription(
  consolidationKey: string,
  contract: string,
  tokenId: number,
  airdropAddress: string,
  subscribedCount: number,
  redeemedCount: number = 0,
  phase: string = 'phase1',
  phasePosition: number = 1
): NFTFinalSubscription {
  return {
    id: 1,
    consolidation_key: consolidationKey,
    contract,
    token_id: tokenId,
    subscribed_count: subscribedCount,
    redeemed_count: redeemedCount,
    airdrop_address: airdropAddress,
    balance: 0,
    subscribed_at: '2024-01-01',
    phase,
    phase_subscriptions: 10,
    phase_position: phasePosition
  };
}

function getSubscriptionSql(transaction: Transaction) {
  return {
    sql: `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
      WHERE ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.contract = ?
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.token_id = ?
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.airdrop_address = ?
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.redeemed_count < ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.subscribed_count
      ORDER BY phase ASC, phase_position ASC;`,
    params: [transaction.contract, transaction.token_id, transaction.to_address]
  };
}

function whenRequestSubscription(
  entityManager: Mock<EntityManager>,
  transaction: Transaction,
  response: NFTFinalSubscription | undefined,
  callCount: number
) {
  const { sql, params } = getSubscriptionSql(transaction);
  for (let i = 0; i < callCount; i++) {
    if (response) {
      const subscriptionWithUpdatedCount = {
        ...response,
        redeemed_count: i
      };
      when(entityManager.query)
        .calledWith(sql, params)
        .mockResolvedValueOnce([subscriptionWithUpdatedCount]);
    } else {
      when(entityManager.query)
        .calledWith(sql, params)
        .mockResolvedValueOnce([]);
    }
  }
}
