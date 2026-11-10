import type { Block, BlockTag, Log } from '@/ethereum-rpc/ethereum-rpc-types';
import { canonicalJson } from '@/nft-history/canonical-json';
import type { RequestContext } from '@/request.context';
import type { TransferConsumer } from '@/transactions/transfer-reconciliation.db';
import {
  anchorsMatch,
  readBlockAnchors,
  WindowNotFinalizedError
} from './block-anchors';
import {
  ChainTransfer,
  summarizeTransferLogs,
  TRANSFER_TOPIC_FILTER
} from './chain-transfers';
import type {
  LedgerInsert,
  StateAuditApplyDb,
  StateAuditJobRow
} from './state-audit-apply.db';
import type { StateAuditApplyRequest } from './state-audit-apply.options';
import {
  ApplyRejection,
  ApplyRejectionCode,
  buildRepairUnits,
  expectedLedgerImage,
  ledgerDiscrepanciesOf,
  planTransactions,
  RepairAction,
  RepairUnit,
  validateApplyManifest
} from './state-audit-apply.plan';
import { diffLedger } from './state-audit.diff';
import {
  digestOf,
  ExpectedLedgerRow,
  LedgerRow,
  StateAuditManifest
} from './state-audit.manifest';
import { describeError, RECONCILIATION_CONSUMERS } from './state-audit.service';

/** The receipt fields apply reads; `EthereumRpcClient.getTransactionReceipt` satisfies it. */
export interface ApplyReceiptLog {
  address: string;
  data: string;
  topics: readonly string[];
  index: number;
  transactionIndex: number;
  removed: boolean;
}

export interface ApplyReceipt {
  blockNumber: number;
  blockHash: string;
  logs: readonly ApplyReceiptLog[];
}

export interface StateAuditApplyRpc {
  getBlock(blockHashOrBlockTag: BlockTag): Promise<Block>;
  getTransactionReceipt(hash: string): Promise<ApplyReceipt | null>;
}

export interface ReconciliationEnqueuer {
  enqueue(
    wallets: string[],
    consumers: TransferConsumer[],
    ctx: RequestContext
  ): Promise<void>;
}

export interface StateAuditApplyDeps {
  rpc: StateAuditApplyRpc;
  db: StateAuditApplyDb;
  reconciliation: ReconciliationEnqueuer;
  /** Chain id the RPC client is bound to. */
  chainId: number;
  now?: () => Date;
  /** Defaults to `STATE_AUDIT_APPLY_ENABLED === 'true'`. */
  applyEnabled?: () => boolean;
}

export const STATE_AUDIT_APPLY_ENV = 'STATE_AUDIT_APPLY_ENABLED';

export type ApplyOutcome =
  | 'planned'
  | 'applied'
  | 'already_applied'
  | 'rejected'
  | 'failed';

export type UnitOutcome =
  | 'planned'
  | 'applied'
  | 'previously_applied'
  | 'stale'
  | 'failed'
  | 'not_reached';

type CheckResult = 'match' | 'mismatch' | 'not_checked';

export interface UnitReport {
  index: number;
  transaction: string;
  block: number;
  outcome: UnitOutcome;
  actions: RepairAction[];
  wallets: string[];
  excluded_wallets: string[];
  error: string | null;
}

export interface StateAuditApplyReport {
  tool: { name: 'state-audit'; mode: 'apply' };
  generated_at: string;
  mode: 'dry-run' | 'live';
  outcome: ApplyOutcome;
  rejection: { code: ApplyRejectionCode; detail: string } | null;
  manifest: {
    plan_digest: string;
    contract: string | null;
    from_block: number | null;
    to_block: number | null;
    generated_at: string;
    status: string;
  } | null;
  job: {
    job_id: string;
    plan_digest: string;
    state: string;
    next_index: number;
    applied_units: number;
    last_error: string | null;
    created: boolean;
  } | null;
  revalidation: {
    anchors: CheckResult;
    receipts_checked: number;
    ledger_image: CheckResult;
    discrepancies: CheckResult;
  };
  units: UnitReport[];
  summary: {
    total_units: number;
    applied_units: number;
    owner_balance_mismatches_deferred: number;
    value_enrichment: 'discovery_defaults';
  };
  enqueued_wallets: string[];
  wallets_not_enqueued: string[];
  tdh: {
    recomputed: false;
    note: string;
    affected_wallets: string[];
    from_block: number | null;
    to_block: number | null;
  };
  not_done: string[];
}

const NOT_DONE = [
  'TDH is not recalculated; historical TDH recomputation is a separate operator action (TDH_RESET) scoped with the affected wallets and blocks reported here.',
  'nft_owners, owners_balances and aggregated activity are not written; the owners and activity queue consumers rebuild them from the corrected ledger.',
  'Inserted rows carry the discovery defaults for value, royalties, gas and USD columns (eth_price_usd from the stored price history only); value enrichment is not run.',
  'The zero address is never enqueued (mirrors repair-wallets); its burn tallies in nft_owners are not refreshed by this step.'
];

const TDH_NOTE =
  'A corrected ledger changes holding periods. Run the documented TDH_RESET path explicitly if TDH for the affected wallets must be recomputed; apply never does this implicitly.';

function createReport(
  request: StateAuditApplyRequest,
  now: Date
): StateAuditApplyReport {
  return {
    tool: { name: 'state-audit', mode: 'apply' },
    generated_at: now.toISOString(),
    mode: request.live ? 'live' : 'dry-run',
    outcome: 'rejected',
    rejection: null,
    manifest: null,
    job: null,
    revalidation: {
      anchors: 'not_checked',
      receipts_checked: 0,
      ledger_image: 'not_checked',
      discrepancies: 'not_checked'
    },
    units: [],
    summary: {
      total_units: 0,
      applied_units: 0,
      owner_balance_mismatches_deferred: 0,
      value_enrichment: 'discovery_defaults'
    },
    enqueued_wallets: [],
    wallets_not_enqueued: [],
    tdh: {
      recomputed: false,
      note: TDH_NOTE,
      affected_wallets: [],
      from_block: null,
      to_block: null
    },
    not_done: NOT_DONE
  };
}

function unitReport(unit: RepairUnit, outcome: UnitOutcome): UnitReport {
  return {
    index: unit.index,
    transaction: unit.transaction,
    block: unit.block,
    outcome,
    actions: unit.actions,
    wallets: unit.wallets,
    excluded_wallets: unit.excluded_wallets,
    error: null
  };
}

function reject(code: ApplyRejectionCode, message: string): never {
  throw new ApplyRejection(code, message);
}

async function withRpc<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApplyRejection) throw error;
    if (error instanceof WindowNotFinalizedError) {
      return reject('stale_chain', error.message);
    }
    return reject('rpc_error', describeError(error));
  }
}

async function withDb<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApplyRejection) throw error;
    return reject('database_error', describeError(error));
  }
}

/**
 * The window ends must still carry the audited hashes and the audited
 * finalized block must still be canonical. The finalized head itself moves
 * on, so its number may only have grown.
 */
async function revalidateAnchors(
  manifest: StateAuditManifest,
  deps: StateAuditApplyDeps
): Promise<void> {
  const anchors = manifest.anchors!;
  const current = await withRpc(() =>
    readBlockAnchors(
      deps.rpc,
      anchors.from_block.number,
      anchors.to_block.number
    )
  );
  if (!anchorsMatch(anchors, current)) {
    reject(
      'stale_chain',
      `window block hashes differ from the manifest (from ${current.from_block.hash}, to ${current.to_block.hash}); rerun the audit`
    );
  }
  const finalized = await withRpc(() =>
    deps.rpc.getBlock(anchors.finalized.number)
  );
  if (
    finalized.hash !== anchors.finalized.hash ||
    current.finalized.number < anchors.finalized.number
  ) {
    reject(
      'stale_chain',
      `finalized block ${anchors.finalized.number} is no longer ${anchors.finalized.hash}; rerun the audit`
    );
  }
}

function receiptLogs(
  transaction: string,
  receipt: ApplyReceipt,
  contract: string
): Log[] {
  return receipt.logs
    .filter(
      (log) =>
        log.address.toLowerCase() === contract &&
        TRANSFER_TOPIC_FILTER.includes(log.topics[0])
    )
    .map((log) => ({
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      transactionIndex: log.transactionIndex,
      transactionHash: transaction,
      address: log.address,
      data: log.data,
      topics: log.topics,
      logIndex: log.index,
      removed: log.removed
    }));
}

/** Re-fetches every plan transaction's receipt and rebuilds its chain edges. */
async function refetchChainTransfers(
  manifest: StateAuditManifest,
  contract: string,
  transactions: string[],
  deps: StateAuditApplyDeps
): Promise<ChainTransfer[]> {
  const inspected = new Map(
    manifest.inspected.transactions.map((entry) => [entry.transaction, entry])
  );
  const logs: Log[] = [];
  for (const transaction of transactions) {
    const receipt = await withRpc(
      () => deps.rpc.getTransactionReceipt(transaction) // NOSONAR -- sequential to respect provider rate limits.
    );
    const audited = inspected.get(transaction);
    if (!receipt) {
      if (audited) {
        reject(
          'stale_chain',
          `transaction ${transaction} was audited in block ${audited.block} but has no receipt now`
        );
      }
      continue;
    }
    const from = manifest.inspected_scope.from_block!;
    const to = manifest.inspected_scope.to_block!;
    if (receipt.blockNumber < from || receipt.blockNumber > to) {
      reject(
        'stale_chain',
        `transaction ${transaction} is now in block ${receipt.blockNumber}, outside the audited window`
      );
    }
    if (
      audited &&
      (audited.block !== receipt.blockNumber ||
        audited.block_hash !== receipt.blockHash)
    ) {
      reject(
        'stale_chain',
        `transaction ${transaction} moved from block ${audited.block} (${audited.block_hash}) to ${receipt.blockNumber} (${receipt.blockHash})`
      );
    }
    receiptLogs(transaction, receipt, contract).forEach((log) =>
      logs.push(log)
    );
  }
  const summary = summarizeTransferLogs(logs, contract);
  if (summary.problems.length) {
    reject(
      'stale_chain',
      `receipt logs did not decode cleanly: ${summary.problems
        .map((problem) => problem.detail)
        .join('; ')}`
    );
  }
  return summary.transfers;
}

function requireSameDiscrepancies(
  manifest: StateAuditManifest,
  chain: ChainTransfer[],
  beforeImage: LedgerRow[],
  transactions: string[]
): void {
  const scoped = new Set(transactions);
  const diff = diffLedger(
    chain,
    beforeImage.filter((row) => scoped.has(row.transaction))
  );
  if (diff.problems.length) {
    reject(
      'stale_chain',
      `recomputed chain edges are not applicable: ${diff.problems
        .map((problem) => problem.detail)
        .join('; ')}`
    );
  }
  if (
    canonicalJson(diff.discrepancies) !==
    canonicalJson(ledgerDiscrepanciesOf(manifest))
  ) {
    reject(
      'plan_mismatch',
      'discrepancies recomputed from the receipts differ from the manifest; rerun the audit'
    );
  }
}

interface LoadedJob {
  row: StateAuditJobRow | null;
  beforeImage: LedgerRow[] | null;
}

async function loadJob(
  request: StateAuditApplyRequest,
  manifest: StateAuditManifest,
  deps: StateAuditApplyDeps
): Promise<LoadedJob> {
  const row = await withDb(() => deps.db.findJob(request.jobId));
  if (!row) return { row: null, beforeImage: null };
  if (row.plan_digest !== manifest.plan_digest) {
    reject(
      'job_digest_mismatch',
      `job ${request.jobId} is bound to plan ${row.plan_digest}, not ${manifest.plan_digest}`
    );
  }
  if (row.state === 'failed') {
    reject(
      'job_failed',
      `job ${request.jobId} failed earlier (${row.last_error ?? 'no detail'}); run a fresh audit and use a new job id`
    );
  }
  let beforeImage: LedgerRow[];
  try {
    beforeImage = JSON.parse(row.before_image_json) as LedgerRow[];
    if (!Array.isArray(beforeImage)) throw new Error('not an array');
  } catch {
    return reject('database_error', 'stored job before-image is unreadable');
  }
  return { row, beforeImage };
}

function jobReport(
  row: StateAuditJobRow,
  created: boolean
): StateAuditApplyReport['job'] {
  return {
    job_id: row.job_id,
    plan_digest: row.plan_digest,
    state: row.state,
    next_index: Number(row.next_index),
    applied_units: Number(row.applied_units),
    last_error: row.last_error,
    created
  };
}

async function blockTimestamps(
  unit: RepairUnit,
  deps: StateAuditApplyDeps
): Promise<Map<string, number>> {
  const timestamps = new Map<string, number>();
  const rows = unit.actions.flatMap((action) =>
    action.action === 'insert' ? [action.row] : []
  );
  for (const row of rows) {
    if (timestamps.has(row.block_hash)) continue;
    const block = await withRpc(() => deps.rpc.getBlock(row.block_hash)); // NOSONAR -- sequential, bounded by the unit's distinct blocks.
    if (block.hash !== row.block_hash || block.number !== row.block) {
      reject(
        'stale_chain',
        `block ${row.block} is no longer ${row.block_hash}; rerun the audit`
      );
    }
    timestamps.set(row.block_hash, block.timestamp);
  }
  return timestamps;
}

function ledgerInsert(
  row: ExpectedLedgerRow,
  timestamp: number,
  now: Date
): LedgerInsert {
  return {
    created_at: now,
    transaction: row.transaction,
    block: row.block,
    transaction_date: new Date(timestamp * 1000),
    from_address: row.from_address,
    to_address: row.to_address,
    contract: row.contract,
    token_id: row.token_id,
    token_count: row.token_count,
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
}

async function executeAction(
  action: RepairAction,
  timestamps: Map<string, number>,
  now: Date,
  db: StateAuditApplyDb,
  ctx: RequestContext
): Promise<void> {
  switch (action.action) {
    case 'insert':
      await db.insertLedgerRow(
        ledgerInsert(action.row, timestamps.get(action.row.block_hash)!, now),
        ctx
      );
      return;
    case 'update_token_count':
      await db.updateTokenCount(action.stored_row, action.token_count, ctx);
      return;
    case 'replace_token_id':
      await db.replaceTokenId(action.stored_row, action.row, ctx);
      return;
    case 'delete':
      await db.deleteLedgerRow(action.stored_row, ctx);
  }
}

/**
 * One unit: lock and re-check the transaction's rows, lock the job cursor,
 * write the corrections, enqueue both endpoints, advance the cursor; all in
 * one REPEATABLE READ transaction like discovery's upsert.
 */
async function applyUnit(
  unit: RepairUnit,
  isLast: boolean,
  request: StateAuditApplyRequest,
  contract: string,
  deps: StateAuditApplyDeps,
  now: Date
): Promise<void> {
  const timestamps = await blockTimestamps(unit, deps);
  await deps.db.executeNativeQueriesInTransaction(
    async (connection) => {
      const ctx: RequestContext = { connection };
      const locked = await deps.db.lockLedgerRowsOfTransaction(
        contract,
        unit.transaction,
        ctx
      );
      if (canonicalJson(locked) !== canonicalJson(unit.before_rows)) {
        reject(
          'stale_database',
          `unit ${unit.index} (${unit.transaction}): ledger rows changed since the manifest was produced`
        );
      }
      const job = await deps.db.lockJob(request.jobId, ctx);
      if (
        !job ||
        job.state !== 'pending' ||
        Number(job.next_index) !== unit.index
      ) {
        reject(
          'job_cursor_changed',
          `job ${request.jobId} cursor is not at unit ${unit.index}; another apply may be running`
        );
      }
      for (const action of unit.actions) {
        await executeAction(action, timestamps, now, deps.db, ctx); // NOSONAR -- statements share the unit's transaction.
      }
      await deps.reconciliation.enqueue(
        unit.wallets,
        RECONCILIATION_CONSUMERS,
        ctx
      );
      await deps.db.advanceJob(
        request.jobId,
        unit.index,
        isLast ? 'applied' : 'pending',
        now,
        ctx
      );
    },
    { isolationLevel: 'REPEATABLE READ' }
  );
}

function addEnqueued(report: StateAuditApplyReport, unit: RepairUnit): void {
  const merged = new Set(report.enqueued_wallets.concat(unit.wallets));
  report.enqueued_wallets = Array.from(merged).sort((a, b) =>
    a.localeCompare(b)
  );
}

async function recordFailure(
  request: StateAuditApplyRequest,
  error: unknown,
  deps: StateAuditApplyDeps,
  now: Date
): Promise<{ code: ApplyRejectionCode; detail: string; terminal: boolean }> {
  const rejection = error instanceof ApplyRejection ? error : null;
  const code = rejection?.code ?? 'database_error';
  const detail = rejection?.message ?? describeError(error);
  // A changed ledger makes the whole plan unsafe: the job ends. A cursor
  // moved by another run is left alone. Anything else stays pending.
  const terminal = code === 'stale_database';
  if (code !== 'job_cursor_changed') {
    try {
      await deps.db.recordJobOutcome(
        request.jobId,
        terminal ? 'failed' : 'pending',
        detail,
        now
      );
    } catch (recordError) {
      return {
        code,
        detail: `${detail}; recording the failure also failed: ${describeError(recordError)}`,
        terminal
      };
    }
  }
  return { code, detail, terminal };
}

async function applyUnits(
  units: RepairUnit[],
  startIndex: number,
  request: StateAuditApplyRequest,
  contract: string,
  deps: StateAuditApplyDeps,
  report: StateAuditApplyReport,
  now: Date
): Promise<void> {
  for (let index = startIndex; index < units.length; index++) {
    const unit = units[index];
    try {
      await applyUnit(
        unit,
        index === units.length - 1,
        request,
        contract,
        deps,
        now
      ); // NOSONAR -- units are applied in cursor order.
    } catch (error) {
      const failure = await recordFailure(request, error, deps, now);
      report.units[index].outcome = failure.terminal ? 'stale' : 'failed';
      report.units[index].error = failure.detail;
      for (let rest = index + 1; rest < units.length; rest++) {
        report.units[rest].outcome = 'not_reached';
      }
      report.outcome = 'failed';
      report.rejection = { code: failure.code, detail: failure.detail };
      return;
    }
    report.units[index].outcome = 'applied';
    report.summary.applied_units += 1;
    addEnqueued(report, unit);
  }
  report.outcome = 'applied';
}

async function runValidated(
  rawManifest: unknown,
  request: StateAuditApplyRequest,
  deps: StateAuditApplyDeps,
  report: StateAuditApplyReport,
  now: Date
): Promise<void> {
  const enabled =
    deps.applyEnabled ?? (() => process.env[STATE_AUDIT_APPLY_ENV] === 'true');
  if (request.live && !enabled()) {
    reject(
      'apply_disabled',
      `live apply is disabled; set ${STATE_AUDIT_APPLY_ENV}=true for this invocation only`
    );
  }
  const manifest = validateApplyManifest(rawManifest, {
    planDigest: request.planDigest,
    chainId: deps.chainId,
    now,
    maxManifestAgeHours: request.maxManifestAgeHours
  });
  const contract = manifest.contract.address!;
  const fromBlock = manifest.inspected_scope.from_block!;
  const toBlock = manifest.inspected_scope.to_block!;
  report.manifest = {
    plan_digest: manifest.plan_digest,
    contract,
    from_block: fromBlock,
    to_block: toBlock,
    generated_at: manifest.generated_at,
    status: manifest.status
  };
  report.summary.owner_balance_mismatches_deferred =
    manifest.summary.owner_balance_mismatch;
  report.tdh.from_block = fromBlock;
  report.tdh.to_block = toBlock;
  report.tdh.affected_wallets = manifest.affected_wallets;

  const job = await loadJob(request, manifest, deps);
  if (job.row) report.job = jobReport(job.row, false);
  if (job.row?.state === 'applied') {
    report.outcome = 'already_applied';
    return;
  }

  await revalidateAnchors(manifest, deps);
  report.revalidation.anchors = 'match';

  const current = await withDb(() =>
    deps.db.readLedgerRowsForWrite(contract, fromBlock, toBlock)
  );
  let beforeImage: LedgerRow[];
  if (job.beforeImage) {
    beforeImage = job.beforeImage;
  } else {
    if (
      digestOf(current) !== manifest.digests.ledger_before_image ||
      current.length !== manifest.ledger_before_image.row_count
    ) {
      report.revalidation.ledger_image = 'mismatch';
      reject(
        'stale_database',
        'ledger rows on the write pool differ from the manifest before-image; rerun the audit'
      );
    }
    beforeImage = current;
  }
  const units = buildRepairUnits(manifest.discrepancies, beforeImage);
  const nextIndex = job.row ? Number(job.row.next_index) : 0;
  if (nextIndex > units.length) {
    reject('database_error', 'stored job cursor is beyond the plan');
  }
  if (
    job.row &&
    digestOf(expectedLedgerImage(beforeImage, units, nextIndex)) !==
      digestOf(current)
  ) {
    report.revalidation.ledger_image = 'mismatch';
    reject(
      'stale_database',
      `ledger rows on the write pool differ from the state expected after ${nextIndex} applied unit(s); the job cannot resume safely`
    );
  }
  report.revalidation.ledger_image = 'match';

  const transactions = planTransactions(units);
  const chain = await refetchChainTransfers(
    manifest,
    contract,
    transactions,
    deps
  );
  report.revalidation.receipts_checked = transactions.length;
  requireSameDiscrepancies(manifest, chain, beforeImage, transactions);
  report.revalidation.discrepancies = 'match';

  report.units = units.map((unit) =>
    unitReport(unit, unit.index < nextIndex ? 'previously_applied' : 'planned')
  );
  report.summary.total_units = units.length;
  units
    .filter((unit) => unit.index < nextIndex)
    .forEach((unit) => addEnqueued(report, unit));
  report.wallets_not_enqueued = Array.from(
    new Set(units.flatMap((unit) => unit.excluded_wallets))
  ).sort((a, b) => a.localeCompare(b));
  report.summary.applied_units = nextIndex;

  if (!request.live) {
    report.outcome = 'planned';
    return;
  }
  if (!job.row) {
    await withDb(() =>
      deps.db.createJob({
        job_id: request.jobId,
        plan_digest: manifest.plan_digest,
        contract,
        from_block: fromBlock,
        to_block: toBlock,
        manifest_json: canonicalJson(manifest),
        before_image_json: canonicalJson(beforeImage),
        created_at: now
      })
    );
  }
  await applyUnits(units, nextIndex, request, contract, deps, report, now);
  const final = await withDb(() => deps.db.findJob(request.jobId));
  if (final) report.job = jobReport(final, !job.row);
}

/**
 * Validates, revalidates and (with `--live`) applies one reviewed manifest.
 * Every refusal is reported as `rejected` with nothing written; a unit
 * failure is reported as `failed` with the job state for resumption. The
 * function only throws for programming errors.
 */
export async function runStateAuditApply(
  rawManifest: unknown,
  request: StateAuditApplyRequest,
  deps: StateAuditApplyDeps
): Promise<StateAuditApplyReport> {
  const now = (deps.now ?? (() => new Date()))();
  const report = createReport(request, now);
  try {
    await runValidated(rawManifest, request, deps, report, now);
  } catch (error) {
    if (!(error instanceof ApplyRejection)) throw error;
    report.outcome = 'rejected';
    report.rejection = { code: error.code, detail: error.message };
  }
  return report;
}
