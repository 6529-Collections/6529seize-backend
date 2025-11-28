import { uuid } from 'short-uuid';
import { Transaction } from '../entities/ITransaction';

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
