export interface Transaction {
  created_at: Date;
  transaction: string;
  block: number;
  transaction_date: Date;
  from_address: string;
  to_address: string;
  contract: string;
  token_id: number;
  token_count: number;
  value: number;
}

export interface TransactionValue {
  transaction: string;
  value: number;
}
