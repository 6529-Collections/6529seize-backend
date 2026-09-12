import { RequestContext } from '@/request.context';

export const BLOCKS_PER_BUCKET = 1_000;
export const DAY_MS = 86_400_000;
export const MAX_BATCHES = 50;
export const MAX_SOURCE_ROWS = 100_000;
export const MAX_ANALYSIS_BLOCK = 2_147_482_000;
export const CANDIDATE_SCAN_LIMIT = 10_000;
export const REPORT_QUERY_BUDGET_MS = 5_000;
export const SOURCE_QUERY_BUDGET_MS = 2_000;
export const ANALYSIS_LOCK_WAIT_SECONDS = 3;
export const TRANSFER_RULE_VERSION = 'memes-transfers-v1';

/** Messages contain only operator input/limits, never SQL or connection data. */
export class WalletTransferAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'WalletTransferAnalysisError';
  }
}

export interface SourceTransfer {
  transaction: string;
  block: number;
  transaction_date: Date | string;
  from_address: string;
  to_address: string;
  contract: string;
  token_id: number | string;
  token_count: number | string;
  value: number | string;
}

export interface PairDailySummary {
  contract: string;
  bucket_start: number;
  day_start: number;
  from_address: string;
  to_address: string;
  transfer_count: number;
  token_count: number;
  first_transfer_at: number;
  last_transfer_at: number;
  sample_transaction: string;
}

export interface WalletDailySummary {
  contract: string;
  bucket_start: number;
  day_start: number;
  wallet: string;
  outbound_count: number;
  inbound_count: number;
  outbound_token_count: number;
  inbound_token_count: number;
}

export interface AnalysisState {
  contract: string;
  last_block: number;
  updated_at: number;
}

export interface SourceBounds {
  minBlock: number | null;
  maxBlock: number | null;
}

/** Window aggregates over stored summaries; quantities are edition units. */
export interface PairMetrics {
  wallet_a: string;
  wallet_b: string;
  a_to_b_count: number;
  b_to_a_count: number;
  a_to_b_token_count: number;
  b_to_a_token_count: number;
  a_to_b_days: number;
  b_to_a_days: number;
  active_days: number;
  first_transfer_at: number;
  last_transfer_at: number;
  sample_transaction_a_to_b: string | null;
  sample_transaction_b_to_a: string | null;
  a_outbound_count: number;
  a_inbound_count: number;
  b_outbound_count: number;
  b_inbound_count: number;
}

export interface TransferAnalysisStore {
  inTransaction<T>(
    fn: (ctx: RequestContext) => Promise<T>,
    ctx: RequestContext
  ): Promise<T>;
  lockState(contract: string, ctx: RequestContext): Promise<AnalysisState>;
  getState(
    contract: string,
    ctx: RequestContext
  ): Promise<AnalysisState | null>;
  getSourceBounds(contract: string, ctx: RequestContext): Promise<SourceBounds>;
  findNextBlock(
    contract: string,
    afterBlock: number,
    toBlock: number,
    ctx: RequestContext
  ): Promise<number | null>;
  loadBucket(
    contract: string,
    start: number,
    end: number,
    maxRows: number,
    ctx: RequestContext
  ): Promise<SourceTransfer[]>;
  replaceBucket(
    contract: string,
    bucketStart: number,
    pairs: PairDailySummary[],
    wallets: WalletDailySummary[],
    advanceToBlock: number | null,
    ctx: RequestContext
  ): Promise<void>;
  listPairMetrics(
    contract: string,
    fromDay: number | null,
    toDayExclusive: number,
    limit: number,
    ctx: RequestContext
  ): Promise<PairMetrics[]>;
  explainSourceBucket(
    contract: string,
    start: number,
    end: number,
    maxRows: number,
    ctx: RequestContext
  ): Promise<Record<string, unknown>[]>;
}
