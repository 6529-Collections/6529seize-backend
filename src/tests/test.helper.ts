import {
  ConnectionWrapper,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { Mock, mock } from 'ts-jest-mocker';
import { when } from 'jest-when';
import { Transaction } from '../entities/ITransaction';
import { uuid } from 'short-uuid';

export async function expectExceptionWithMessage(
  scenario: () => unknown,
  message: string
) {
  try {
    await scenario();
    throw new Error(
      `Expected an exception with message ${message}, but it never happened`
    );
  } catch (e: any) {
    expect(e?.message).toBe(message);
  }
}

export function mockDbService<T extends LazyDbAccessCompatibleService>(
  clazz?: new (...args: any[]) => T
): Mock<T> {
  const mocked = mock(clazz);
  when(mocked.executeNativeQueriesInTransaction).mockImplementation(
    async (lambda) => await lambda({ connection: {} })
  );
  return mocked;
}

export const mockConnection: ConnectionWrapper<any> = {
  connection: {}
};

export function generateRandomTokenId(): number {
  return Math.floor(Math.random() * 10000) + 1;
}

export function buildTransaction(
  from_address: string,
  to_address: string,
  contract: string,
  token_id: number,
  token_count: number = 1,
  value: number = 0
): Transaction {
  const transaction: Transaction = {
    created_at: new Date(),
    transaction: uuid(),
    block: 1,
    transaction_date: new Date(),
    from_address,
    to_address,
    contract,
    token_id,
    token_count,
    value,
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
  return transaction;
}
