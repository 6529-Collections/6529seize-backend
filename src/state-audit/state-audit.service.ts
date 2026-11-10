import { NULL_ADDRESS } from '@/constants';
import { NEXTGEN_CORE_CONTRACT } from '@/nextgen/nextgen_constants';
import type { TransferConsumer } from '@/transactions/transfer-reconciliation.db';
import {
  anchorsMatch,
  readBlockAnchors,
  StateAuditRpc,
  WindowNotFinalizedError
} from './block-anchors';
import { ChainTransfer, fetchChainTransfers } from './chain-transfers';
import {
  compareOwnerBalances,
  expectedBalances,
  MAX_OWNER_CHECK_WALLETS,
  OWNER_CHECK_ASSUMPTIONS
} from './owner-balance-check';
import type { StateAuditDb } from './state-audit.db';
import { affectedWalletsOf, diffLedger } from './state-audit.diff';
import {
  computePlanDigest,
  digestOf,
  Discrepancy,
  emptySummary,
  InconclusiveReason,
  LedgerRow,
  OwnerBalanceCheck,
  STATE_AUDIT_MANIFEST_VERSION,
  StateAuditManifest,
  StateAuditStatus
} from './state-audit.manifest';
import {
  isHexAddress,
  KNOWN_CONTRACTS,
  KnownContractName,
  StateAuditRequest
} from './state-audit.options';

export interface StateAuditDeps {
  rpc: StateAuditRpc;
  db: StateAuditDb;
  /** Chain id the RPC client is bound to. */
  chainId: number;
  now?: () => Date;
}

export const RECONCILIATION_CONSUMERS: TransferConsumer[] = [
  'owners',
  'activity'
];

const DATA_SOURCES = [
  'eth_getLogs on the contract address filtered to ERC-721 Transfer, ERC-1155 TransferSingle and TransferBatch topics, via the configured Ethereum RPC',
  'eth_getBlockByNumber for the window ends and the finalized head (block anchors)',
  'SELECT from the transactions table (read pool) for the contract and block window',
  'SELECT from the transactions and nft_owners tables (read pool) for the derived owner-balance check'
];

const VERIFICATION_ASSUMPTIONS = [
  'The RPC endpoint returns complete eth_getLogs results for each chunk; a chunk at the provider cap is treated as possibly truncated.',
  'The window end is at or below the finalized head and the window-end hashes are unchanged after the logs were read; intermediate block hashes are recorded per transaction but not re-fetched.',
  'Transfer semantics follow the ingest path: edges are summed per transaction and from:to:contract:tokenId, mints come from the zero address, burns go to the zero or dead address, and the dead address is an ordinary wallet.',
  'Only transaction, block, from_address, to_address, contract, token_id and token_count are compared; value, royalty, gas and date columns are out of scope.',
  'MySQL address comparisons rely on the case-insensitive collation of the ledger columns; rows are normalized to lowercase for the manifest.',
  'The ledger composite primary key prevents exact duplicate rows; case-variant duplicates of one normalized edge are reported as unexpected rows.',
  'The derived owner-balance check is a derived comparison with the assumptions listed under derived_checks.owner_balance.'
];

type ContractResolution =
  | { supported: true; address: string; name: KnownContractName }
  | { supported: false; address: string | null; reason: string };

export function resolveAuditContract(requested: string): ContractResolution {
  const names = Object.keys(KNOWN_CONTRACTS) as KnownContractName[];
  const byName = names.find((name) => name === requested.toLowerCase());
  if (byName) {
    return {
      supported: true,
      address: KNOWN_CONTRACTS[byName].toLowerCase(),
      name: byName
    };
  }
  if (!isHexAddress(requested)) {
    return {
      supported: false,
      address: null,
      reason: `contract ${requested} is not a known name or address`
    };
  }
  const address = requested.toLowerCase();
  const byAddress = names.find(
    (name) => KNOWN_CONTRACTS[name].toLowerCase() === address
  );
  if (byAddress) {
    return { supported: true, address, name: byAddress };
  }
  const nextgen = Object.values(NEXTGEN_CORE_CONTRACT).some(
    (candidate) => candidate.toLowerCase() === address
  );
  return {
    supported: false,
    address,
    reason: nextgen
      ? `contract ${address} is a NextGen core contract; its ledger rows are written by nextgenContractLoop and are not audited by this tool`
      : `contract ${address} is not Memes, Gradients or Meme Lab; external and unknown collections are not audited by this tool`
  };
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 300);
}

function createDraft(
  request: StateAuditRequest,
  resolution: ContractResolution,
  deps: StateAuditDeps
): StateAuditManifest {
  const manifest: StateAuditManifest = {
    manifest_version: STATE_AUDIT_MANIFEST_VERSION,
    generated_at: (deps.now ?? (() => new Date()))().toISOString(),
    tool: { name: 'state-audit', mode: 'read-only' },
    status: 'inconclusive',
    inconclusive_reasons: [],
    chain_id: request.chainId,
    contract: {
      requested: request.contract,
      address: resolution.address,
      name: resolution.supported ? resolution.name : null,
      supported: resolution.supported
    },
    requested_scope: {
      from_block: request.fromBlock,
      to_block: request.toBlock,
      wallets_filter: request.wallets
    },
    inspected_scope: {
      from_block: null,
      to_block: null,
      blocks_inspected: 0,
      complete: false,
      chunks: []
    },
    anchors: null,
    data_sources: DATA_SOURCES,
    verification_assumptions: VERIFICATION_ASSUMPTIONS,
    inspected: { transactions: [], log_count: 0, edge_count: 0 },
    digests: { chain_edges: null, ledger_before_image: null },
    ledger_before_image: { row_count: null },
    summary: emptySummary(),
    discrepancies: [],
    affected_wallets: [],
    derived_checks: {
      owner_balance: {
        status: 'not_applicable',
        reason: 'audit did not reach the derived check',
        owners_block_reference: null,
        wallets_checked: [],
        assumptions: OWNER_CHECK_ASSUMPTIONS
      }
    },
    reconciliation_plan: {
      consumers: RECONCILIATION_CONSUMERS,
      wallets: [],
      enqueue_pattern:
        "transferReconciliationDb.enqueue(wallets, ['owners','activity'], { connection }) in the same transaction as the ledger correction",
      notes: [
        'Nothing is enqueued by the audit; this is the work a separate, gated apply step would perform.',
        'The repair-wallets maintenance action rejects the zero address; drop it from the list when using that route.'
      ]
    },
    plan_digest: ''
  };
  return manifest;
}

function statusOf(
  reasons: InconclusiveReason[],
  discrepancies: Discrepancy[]
): StateAuditStatus {
  if (reasons.length) return 'inconclusive';
  return discrepancies.length ? 'differences_found' : 'clean';
}

function finalize(manifest: StateAuditManifest): StateAuditManifest {
  manifest.status = statusOf(
    manifest.inconclusive_reasons,
    manifest.discrepancies
  );
  manifest.summary = emptySummary();
  manifest.discrepancies.forEach((discrepancy) => {
    manifest.summary[discrepancy.type] += 1;
  });
  manifest.affected_wallets = affectedWalletsOf(manifest.discrepancies);
  manifest.reconciliation_plan.wallets = manifest.affected_wallets.slice();
  manifest.plan_digest = computePlanDigest(manifest);
  return manifest;
}

function chainEdgeDigest(transfers: ChainTransfer[]): string {
  return digestOf(
    transfers.map((transfer) => ({
      ...transfer,
      amount: transfer.amount.toString()
    }))
  );
}

function ownerCheckWallets(
  request: StateAuditRequest,
  affected: string[]
): string[] {
  const zero = NULL_ADDRESS.toLowerCase();
  const base = request.wallets.length ? request.wallets : affected;
  return base.filter((wallet) => wallet !== zero);
}

async function runOwnerBalanceCheck(
  request: StateAuditRequest,
  contract: string,
  chain: ChainTransfer[],
  wallets: string[],
  deps: StateAuditDeps
): Promise<{ check: OwnerBalanceCheck; discrepancies: Discrepancy[] }> {
  const check: OwnerBalanceCheck = {
    status: 'not_applicable',
    reason: null,
    owners_block_reference: null,
    wallets_checked: [],
    assumptions: OWNER_CHECK_ASSUMPTIONS
  };
  if (!wallets.length) {
    check.reason = 'no wallets to check';
    return { check, discrepancies: [] };
  }
  if (wallets.length > MAX_OWNER_CHECK_WALLETS) {
    check.status = 'truncated';
    check.reason = `${wallets.length} wallets exceed the ${MAX_OWNER_CHECK_WALLETS}-wallet limit; narrow the window or pass --wallets`;
    return { check, discrepancies: [] };
  }
  const blockReference = await deps.db.readOwnersBlockReference(contract);
  check.owners_block_reference = blockReference;
  if (blockReference === null) {
    check.status = 'skipped';
    check.reason = 'nft_owners holds no rows for this contract';
    return { check, discrepancies: [] };
  }
  if (blockReference < request.toBlock) {
    check.status = 'skipped';
    check.reason = `nft_owners block_reference ${blockReference} is below the window end ${request.toBlock}; the owners consumer has not published this window yet`;
    return { check, discrepancies: [] };
  }
  const [history, stored] = await Promise.all([
    deps.db.readLedgerHistoryForWallets(contract, wallets, blockReference),
    deps.db.readOwnerRows(contract, wallets)
  ]);
  const expected = expectedBalances({
    wallets,
    history,
    chain,
    fromBlock: request.fromBlock,
    toBlock: request.toBlock,
    blockReference
  });
  check.status = 'evaluated';
  check.wallets_checked = wallets;
  return {
    check,
    discrepancies: compareOwnerBalances(contract, expected, stored)
  };
}

async function readLedger(
  manifest: StateAuditManifest,
  contract: string,
  request: StateAuditRequest,
  deps: StateAuditDeps
): Promise<LedgerRow[] | null> {
  try {
    const rows = await deps.db.readLedgerRows(
      contract,
      request.fromBlock,
      request.toBlock
    );
    manifest.ledger_before_image = { row_count: rows.length };
    manifest.digests.ledger_before_image = digestOf(rows);
    return rows;
  } catch (error) {
    manifest.inconclusive_reasons.push({
      code: 'database_error',
      detail: describeError(error)
    });
    return null;
  }
}

async function auditSupportedContract(
  manifest: StateAuditManifest,
  contract: string,
  request: StateAuditRequest,
  deps: StateAuditDeps
): Promise<void> {
  let chain: ChainTransfer[];
  try {
    const anchors = await readBlockAnchors(
      deps.rpc,
      request.fromBlock,
      request.toBlock
    );
    manifest.anchors = anchors;
    const fetched = await fetchChainTransfers(
      deps.rpc,
      contract,
      request.fromBlock,
      request.toBlock
    );
    manifest.inspected_scope = {
      from_block: request.fromBlock,
      to_block: request.toBlock,
      blocks_inspected: request.toBlock - request.fromBlock + 1,
      complete: fetched.problems.length === 0,
      chunks: fetched.chunks
    };
    manifest.inspected = {
      transactions: fetched.inspected,
      log_count: fetched.log_count,
      edge_count: fetched.transfers.length
    };
    manifest.digests.chain_edges = chainEdgeDigest(fetched.transfers);
    fetched.problems.forEach((problem) =>
      manifest.inconclusive_reasons.push(problem)
    );
    const recheck = await readBlockAnchors(
      deps.rpc,
      request.fromBlock,
      request.toBlock
    );
    if (!anchorsMatch(anchors, recheck)) {
      manifest.inconclusive_reasons.push({
        code: 'anchors_changed',
        detail:
          'window block hashes changed while logs were being read; rerun the audit'
      });
      return;
    }
    chain = fetched.transfers;
  } catch (error) {
    manifest.inconclusive_reasons.push(
      error instanceof WindowNotFinalizedError
        ? { code: 'window_not_finalized', detail: error.message }
        : { code: 'rpc_error', detail: describeError(error) }
    );
    return;
  }

  const ledger = await readLedger(manifest, contract, request, deps);
  if (ledger === null) return;
  const diff = diffLedger(chain, ledger);
  diff.problems.forEach((problem) =>
    manifest.inconclusive_reasons.push(problem)
  );
  manifest.discrepancies = diff.discrepancies;

  try {
    const owners = await runOwnerBalanceCheck(
      request,
      contract,
      chain,
      ownerCheckWallets(request, diff.affected_wallets),
      deps
    );
    manifest.derived_checks.owner_balance = owners.check;
    manifest.discrepancies = manifest.discrepancies.concat(
      owners.discrepancies
    );
    if (owners.check.status === 'truncated') {
      manifest.inconclusive_reasons.push({
        code: 'owner_check_truncated',
        detail: owners.check.reason ?? 'owner check truncated'
      });
    }
  } catch (error) {
    manifest.inconclusive_reasons.push({
      code: 'database_error',
      detail: describeError(error)
    });
  }
}

/**
 * Runs one bounded, read-only audit and returns its manifest. Every failure
 * mode is reported inside the manifest as `inconclusive`; the function only
 * throws for programming errors.
 */
export async function runStateAudit(
  request: StateAuditRequest,
  deps: StateAuditDeps
): Promise<StateAuditManifest> {
  const resolution = resolveAuditContract(request.contract);
  const manifest = createDraft(request, resolution, deps);
  if (!resolution.supported) {
    manifest.inconclusive_reasons.push({
      code: 'unsupported_contract',
      detail: resolution.reason
    });
    return finalize(manifest);
  }
  if (request.chainId !== deps.chainId) {
    manifest.inconclusive_reasons.push({
      code: 'chain_id_mismatch',
      detail: `requested chain ${request.chainId} but the RPC client is configured for chain ${deps.chainId}`
    });
    return finalize(manifest);
  }
  await auditSupportedContract(manifest, resolution.address, request, deps);
  return finalize(manifest);
}
