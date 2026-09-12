import { MEMES_CONTRACT } from '@/constants';
import { dbSupplier } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { aggregateTransferBucket } from '@/wallet-transfer-analysis/aggregate';
import {
  rankTransferPairs,
  TRANSFER_RULES
} from '@/wallet-transfer-analysis/score';
import {
  BLOCKS_PER_BUCKET,
  CANDIDATE_SCAN_LIMIT,
  DAY_MS,
  MAX_BATCHES,
  MAX_ANALYSIS_BLOCK,
  MAX_SOURCE_ROWS,
  REPORT_QUERY_BUDGET_MS,
  TRANSFER_RULE_VERSION,
  TransferAnalysisStore,
  WalletTransferAnalysisError
} from '@/wallet-transfer-analysis/types';
import { WalletTransferAnalysisDb } from '@/wallet-transfer-analysis/wallet-transfer-analysis.db';

export { WalletTransferAnalysisError } from '@/wallet-transfer-analysis/types';

interface BatchResult {
  bucket_start: number;
  bucket_end: number;
  source_rows: number;
  pair_days: number;
  wallet_days: number;
  elapsed_ms: number;
  reconciled: boolean;
}

function integerInRange(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WalletTransferAnalysisError(
      `${name} must be an integer between ${min} and ${max}`
    );
  }
}

function bucketStart(block: number) {
  return Math.floor(block / BLOCKS_PER_BUCKET) * BLOCKS_PER_BUCKET;
}

function validateRange(fromBlock: number, toBlock: number) {
  integerInRange(fromBlock, 0, MAX_ANALYSIS_BLOCK, 'from-block');
  integerInRange(toBlock, fromBlock, MAX_ANALYSIS_BLOCK, 'to-block');
  return {
    start: bucketStart(fromBlock),
    end: bucketStart(toBlock) + BLOCKS_PER_BUCKET - 1
  };
}

export class WalletTransferAnalysisService {
  private readonly contract: string;

  constructor(
    private readonly store: TransferAnalysisStore,
    private readonly now: () => number = Date.now,
    contract = MEMES_CONTRACT
  ) {
    this.contract = contract.toLowerCase();
  }

  async status() {
    const ctx: RequestContext = {};
    const state = await this.store.getState(this.contract, ctx);
    const bounds = await this.store.getSourceBounds(this.contract, ctx);
    return {
      contract: this.contract,
      rule_version: TRANSFER_RULE_VERSION,
      blocks_per_bucket: BLOCKS_PER_BUCKET,
      state,
      source_min_block: bounds.minBlock,
      source_max_block: bounds.maxBlock,
      source_block_range_covered:
        bounds.maxBlock === null ||
        (state !== null && state.last_block >= bounds.maxBlock)
    };
  }

  async explain(options: {
    fromBlock: number;
    toBlock: number;
    maxRows: number;
  }) {
    integerInRange(options.maxRows, 1, MAX_SOURCE_ROWS, 'max-rows');
    const range = validateRange(options.fromBlock, options.toBlock);
    if (range.end - range.start + 1 !== BLOCKS_PER_BUCKET) {
      throw new WalletTransferAnalysisError('Explain accepts one block bucket');
    }
    return {
      contract: this.contract,
      bucket_start: range.start,
      bucket_end: range.end,
      source_row_limit: options.maxRows + 1,
      query_plan: await this.store.explainSourceBucket(
        this.contract,
        range.start,
        range.end,
        options.maxRows,
        {}
      )
    };
  }

  async update(options: { maxBatches: number; maxRows: number }) {
    integerInRange(options.maxBatches, 1, MAX_BATCHES, 'max-batches');
    integerInRange(options.maxRows, 1, MAX_SOURCE_ROWS, 'max-rows');
    const bounds = await this.store.getSourceBounds(this.contract, {});
    const refreshed: BatchResult[] = [];
    if (bounds.maxBlock === null) return this.result(null, refreshed);
    const highWater = bounds.maxBlock;

    // The last bucket may have been only partly populated by the source indexer.
    // Replace it on every invocation. This extra bounded reconciliation does not
    // consume the forward-work allowance, so --max-batches=1 still progresses.
    const reconciled = await this.store.inTransaction(async (ctx) => {
      const state = await this.store.lockState(this.contract, ctx);
      if (state.last_block < 0) return null;
      return this.refreshBucket(
        bucketStart(state.last_block),
        options.maxRows,
        false,
        ctx
      );
    }, {});
    if (reconciled) refreshed.push(reconciled);

    for (let index = 0; index < options.maxBatches; index++) {
      const batch = await this.processNextBucket(highWater, options.maxRows);
      if (!batch) break;
      refreshed.push(batch);
    }
    return this.result(highWater, refreshed);
  }

  private processNextBucket(highWater: number, maxRows: number) {
    return this.store.inTransaction(async (ctx) => {
      const state = await this.store.lockState(this.contract, ctx);
      const nextBlock = await this.store.findNextBlock(
        this.contract,
        state.last_block,
        highWater,
        ctx
      );
      if (nextBlock === null) return null;
      return this.refreshBucket(bucketStart(nextBlock), maxRows, true, ctx);
    }, {});
  }

  async rebuild(options: {
    fromBlock: number;
    toBlock: number;
    maxRows: number;
  }) {
    integerInRange(options.maxRows, 1, MAX_SOURCE_ROWS, 'max-rows');
    const range = validateRange(options.fromBlock, options.toBlock);
    const count = (range.end - range.start + 1) / BLOCKS_PER_BUCKET;
    if (count > MAX_BATCHES) {
      throw new WalletTransferAnalysisError(
        `Rebuild is limited to ${MAX_BATCHES} block buckets per invocation`
      );
    }
    const state = await this.store.getState(this.contract, {});
    if (!state || range.end > state.last_block) {
      throw new WalletTransferAnalysisError(
        'Rebuild only accepts already processed buckets; use update to advance history'
      );
    }
    const refreshed: BatchResult[] = [];
    for (
      let start = range.start;
      start <= range.end;
      start += BLOCKS_PER_BUCKET
    ) {
      refreshed.push(
        await this.store.inTransaction(async (ctx) => {
          await this.store.lockState(this.contract, ctx);
          return this.refreshBucket(start, options.maxRows, false, ctx);
        }, {})
      );
    }
    return this.result(null, refreshed);
  }

  private async refreshBucket(
    start: number,
    maxRows: number,
    advance: boolean,
    ctx: RequestContext
  ): Promise<BatchResult> {
    const started = this.now();
    const end = start + BLOCKS_PER_BUCKET - 1;
    const rows = await this.store.loadBucket(
      this.contract,
      start,
      end,
      maxRows,
      ctx
    );
    if (rows.length > maxRows) {
      throw new WalletTransferAnalysisError(
        `Bucket ${start}-${end} exceeds max-rows=${maxRows}; checkpoint was not advanced. Increase the bounded row limit after checking its query plan.`
      );
    }
    let summaries: ReturnType<typeof aggregateTransferBucket>;
    try {
      summaries = aggregateTransferBucket(rows, this.contract, start);
    } catch {
      throw new WalletTransferAnalysisError(
        `Bucket ${start}-${end} has invalid source data; checkpoint was not advanced`
      );
    }
    await this.store.replaceBucket(
      this.contract,
      start,
      summaries.pairs,
      summaries.wallets,
      advance ? end : null,
      ctx
    );
    return {
      bucket_start: start,
      bucket_end: end,
      source_rows: rows.length,
      pair_days: summaries.pairs.length,
      wallet_days: summaries.wallets.length,
      elapsed_ms: this.now() - started,
      reconciled: !advance
    };
  }

  private async result(
    sourceMaxBlock: number | null,
    refreshed: BatchResult[]
  ) {
    return {
      rule_version: TRANSFER_RULE_VERSION,
      contract: this.contract,
      source_max_block: sourceMaxBlock,
      refreshed_buckets: refreshed,
      state: await this.store.getState(this.contract, {})
    };
  }

  async report(options: { days: 30 | 90 | 365 | null; limit: number }) {
    integerInRange(options.limit, 1, 1_000, 'limit');
    if (options.days !== null && ![30, 90, 365].includes(options.days)) {
      throw new WalletTransferAnalysisError('days must be 30, 90, 365, or all');
    }
    const generatedAt = this.now();
    const toDay = Math.floor(generatedAt / DAY_MS) * DAY_MS + DAY_MS;
    const fromDay =
      options.days === null ? null : toDay - options.days * DAY_MS;
    return this.store.inTransaction(async (ctx) => {
      const state = await this.store.getState(this.contract, ctx);
      const bounds = await this.store.getSourceBounds(this.contract, ctx);
      const rows = await this.store.listPairMetrics(
        this.contract,
        fromDay,
        toDay,
        CANDIDATE_SCAN_LIMIT + 1,
        ctx
      );
      const selected = rows.slice(0, CANDIDATE_SCAN_LIMIT);
      return {
        contract: this.contract,
        rule_version: TRANSFER_RULE_VERSION,
        rules: TRANSFER_RULES,
        generated_at: generatedAt,
        from_day: fromDay,
        to_day_exclusive: toDay,
        source_min_block: bounds.minBlock,
        source_max_block: bounds.maxBlock,
        summary_state: state,
        source_block_range_covered:
          bounds.maxBlock === null ||
          (state !== null && state.last_block >= bounds.maxBlock),
        candidate_scan_limit: CANDIDATE_SCAN_LIMIT,
        report_query_budget_ms: REPORT_QUERY_BUDGET_MS,
        freshness_note:
          'Block-range coverage does not detect changed rows. Update reconciles the latest processed bucket; rebuild reconciles older corrections.',
        preselection_truncated: rows.length > CANDIDATE_SCAN_LIMIT,
        preselection: 'highest total transfer occasions among undeclared pairs',
        score_meaning:
          'review priority within preselection, not ownership probability',
        candidates: rankTransferPairs(selected, options.limit)
      };
    }, {});
  }
}

export const walletTransferAnalysisService = new WalletTransferAnalysisService(
  new WalletTransferAnalysisDb(dbSupplier)
);
