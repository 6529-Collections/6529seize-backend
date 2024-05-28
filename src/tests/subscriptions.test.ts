import { Mock, mock } from 'ts-jest-mocker';
import { EntityManager } from 'typeorm';
import { validateNonSubscriptionAirdrop } from '../transactionsProcessingLoop/subscriptions';
import { Transaction } from '../entities/ITransaction';
import { uuid } from 'short-uuid';
import {
  DISTRIBUTION_TABLE,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  RESEARCH_6529_ADDRESS,
  TRANSACTIONS_TABLE
} from '../constants';
import { when } from 'jest-when';

describe('SubscriptionTests', () => {
  let entityManager: Mock<EntityManager>;

  beforeEach(() => {
    entityManager = mock(EntityManager);
  });

  describe('validateNonSubscriptionAirdrop', () => {
    it('not memes contract', async () => {
      const transaction: Transaction = {
        created_at: new Date(),
        transaction: uuid(),
        block: 1,
        transaction_date: new Date(),
        from_address: NULL_ADDRESS,
        to_address: '0x123',
        contract: GRADIENT_CONTRACT,
        token_id: 237,
        token_count: 1,
        value: 0,
        primary_proceeds: 0,
        royalties: 0,
        gas_gwei: 0,
        gas_price: 0,
        gas_price_gwei: 0,
        gas: 0,
        eth_price_usd: 0,
        value_usd: 0,
        gas_usd: 0
      };
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
      const transaction: Transaction = {
        created_at: new Date(),
        transaction: uuid(),
        block: 1,
        transaction_date: new Date(),
        from_address: NULL_ADDRESS,
        to_address: RESEARCH_6529_ADDRESS,
        contract: MEMES_CONTRACT,
        token_id: 237,
        token_count: 1,
        value: 0,
        primary_proceeds: 0,
        royalties: 0,
        gas_gwei: 0,
        gas_price: 0,
        gas_price_gwei: 0,
        gas: 0,
        eth_price_usd: 0,
        value_usd: 0,
        gas_usd: 0
      };
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
      const transaction: Transaction = {
        created_at: new Date(),
        transaction: uuid(),
        block: 1,
        transaction_date: new Date(),
        from_address: NULL_ADDRESS,
        to_address: '0x123',
        contract: MEMES_CONTRACT,
        token_id: 237,
        token_count: 1,
        value: 0,
        primary_proceeds: 0,
        royalties: 0,
        gas_gwei: 0,
        gas_price: 0,
        gas_price_gwei: 0,
        gas: 0,
        eth_price_usd: 0,
        value_usd: 0,
        gas_usd: 0
      };
      whenRequestDistribution(entityManager, transaction, { count: 1 });
      whenRequestAirdrops(entityManager, transaction, 0);
      const response = await validateNonSubscriptionAirdrop(
        transaction,
        entityManager
      );
      expect(response).toEqual({
        valid: true,
        message: 'Initial airdrop'
      });
      expect(entityManager.query).toHaveBeenCalledTimes(2);
    });

    it('in initial airdrop 2', async () => {
      const transaction: Transaction = {
        created_at: new Date(),
        transaction: uuid(),
        block: 1,
        transaction_date: new Date(),
        from_address: NULL_ADDRESS,
        to_address: '0x123',
        contract: MEMES_CONTRACT,
        token_id: 237,
        token_count: 1,
        value: 0,
        primary_proceeds: 0,
        royalties: 0,
        gas_gwei: 0,
        gas_price: 0,
        gas_price_gwei: 0,
        gas: 0,
        eth_price_usd: 0,
        value_usd: 0,
        gas_usd: 0
      };
      whenRequestDistribution(entityManager, transaction, { count: 2 });
      whenRequestAirdrops(entityManager, transaction, 1);
      const response = await validateNonSubscriptionAirdrop(
        transaction,
        entityManager
      );
      expect(response).toEqual({
        valid: true,
        message: 'Initial airdrop'
      });
      expect(entityManager.query).toHaveBeenCalledTimes(2);
    });

    it('not in initial airdrop', async () => {
      const transaction: Transaction = {
        created_at: new Date(),
        transaction: uuid(),
        block: 1,
        transaction_date: new Date(),
        from_address: NULL_ADDRESS,
        to_address: '0x123',
        contract: MEMES_CONTRACT,
        token_id: 237,
        token_count: 1,
        value: 0,
        primary_proceeds: 0,
        royalties: 0,
        gas_gwei: 0,
        gas_price: 0,
        gas_price_gwei: 0,
        gas: 0,
        eth_price_usd: 0,
        value_usd: 0,
        gas_usd: 0
      };
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
      const transaction: Transaction = {
        created_at: new Date(),
        transaction: uuid(),
        block: 1,
        transaction_date: new Date(),
        from_address: NULL_ADDRESS,
        to_address: '0x123',
        contract: MEMES_CONTRACT,
        token_id: 237,
        token_count: 1,
        value: 0,
        primary_proceeds: 0,
        royalties: 0,
        gas_gwei: 0,
        gas_price: 0,
        gas_price_gwei: 0,
        gas: 0,
        eth_price_usd: 0,
        value_usd: 0,
        gas_usd: 0
      };
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
