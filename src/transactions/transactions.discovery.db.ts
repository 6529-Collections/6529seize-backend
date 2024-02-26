import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { TRANSACTIONS_TABLE } from '../constants';
import { Transaction } from '../entities/ITransaction';

export class TransactionsDiscoveryDb extends LazyDbAccessCompatibleService {
  async getLatestTransactionsBlockForContract(
    contract: string
  ): Promise<number> {
    return this.db
      .execute(
        `select max(t.block) as block from ${TRANSACTIONS_TABLE} t where t.contract = :contract`,
        { contract }
      )
      .then((result: { block: number | null }[]) => result[0]?.block ?? 0);
  }

  async batchUpsertTransactions(transactions: Transaction[]): Promise<void> {
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      for (const transaction of transactions) {
        await this.db.execute(
          `
                insert into ${TRANSACTIONS_TABLE} (
                  created_at, 
                  transaction, 
                  block, 
                  transaction_date, 
                  from_address, 
                  to_address, 
                  contract, 
                  token_id, 
                  token_count, 
                  value, 
                  royalties, 
                  gas_gwei, 
                  gas_price, 
                  gas_price_gwei, 
                  gas, 
                  primary_proceeds
                ) values (
                  :created_at,
                  :transaction,
                  :block,
                  :transaction_date,
                  :from_address,
                  :to_address,
                  :contract,
                  :token_id,
                  :token_count,
                  :value,
                  :royalties,
                  :gas_gwei,
                  :gas_price,
                  :gas_price_gwei,
                  :gas,
                  :primary_proceeds
                ) on duplicate key update
                    created_at = :created_at,
                    block = :block,
                    transaction_date = :transaction_date,
                    token_count = :token_count,
                    value = :value,
                    royalties = :royalties,
                    gas_gwei = :gas_gwei,
                    gas_price = :gas_price,
                    gas_price_gwei = :gas_price_gwei,
                    gas = :gas,
                    primary_proceeds = :primary_proceeds
      `,
          transaction,
          { wrappedConnection: connection }
        );
      }
    });
  }
}

export const transactionsDb = new TransactionsDiscoveryDb(dbSupplier);
