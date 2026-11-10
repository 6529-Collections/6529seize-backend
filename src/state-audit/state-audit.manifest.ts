import { canonicalJson, historyDigest } from '@/nft-history/canonical-json';
import type { TransferConsumer } from '@/transactions/transfer-reconciliation.db';
import type { KnownContractName } from './state-audit.options';

export const STATE_AUDIT_MANIFEST_VERSION = 1;

export type StateAuditStatus = 'clean' | 'differences_found' | 'inconclusive';

export type InconclusiveReasonCode =
  | 'unsupported_contract'
  | 'chain_id_mismatch'
  | 'window_not_finalized'
  | 'rpc_error'
  | 'database_error'
  | 'anchors_changed'
  | 'log_response_capped'
  | 'unparsed_log'
  | 'foreign_log'
  | 'amount_overflow'
  | 'owner_check_truncated';

export interface InconclusiveReason {
  code: InconclusiveReasonCode;
  detail: string;
}

export interface BlockAnchor {
  number: number;
  hash: string;
}

export interface BlockAnchors {
  from_block: BlockAnchor;
  to_block: BlockAnchor;
  finalized: BlockAnchor;
}

/** Normalized before-image of one `transactions` row read for the scope. */
export interface LedgerRow {
  transaction: string;
  block: number;
  from_address: string;
  to_address: string;
  contract: string;
  token_id: string;
  token_count: number;
}

/** The ledger row the chain says should exist. */
export interface ExpectedLedgerRow extends LedgerRow {
  block_hash: string;
  log_indexes: number[];
}

export interface OwnerRow {
  wallet: string;
  contract: string;
  token_id: string;
  balance: number;
  block_reference: number;
}

export interface ExpectedOwnerRow {
  wallet: string;
  contract: string;
  token_id: string;
  balance: number;
}

export type UnexpectedRowDetail =
  | 'no_chain_transaction'
  | 'no_chain_edge'
  | 'duplicate_normalized_key';

export type Discrepancy =
  | {
      type: 'missing_transaction';
      transaction: string;
      block: number;
      stored_rows: [];
      expected_rows: ExpectedLedgerRow[];
    }
  | {
      type: 'missing_edge';
      transaction: string;
      stored_row: null;
      expected_row: ExpectedLedgerRow;
    }
  | {
      type: 'token_count_mismatch' | 'token_id_mismatch';
      transaction: string;
      stored_row: LedgerRow;
      expected_row: ExpectedLedgerRow;
    }
  | {
      type: 'unexpected_row';
      transaction: string;
      detail: UnexpectedRowDetail;
      stored_row: LedgerRow;
      expected_row: null;
    }
  | {
      type: 'owner_balance_mismatch';
      wallet: string;
      token_id: string;
      stored_row: OwnerRow | null;
      expected_row: ExpectedOwnerRow;
    };

export type DiscrepancyType = Discrepancy['type'];

export const DISCREPANCY_TYPES: readonly DiscrepancyType[] = [
  'missing_transaction',
  'missing_edge',
  'token_count_mismatch',
  'token_id_mismatch',
  'unexpected_row',
  'owner_balance_mismatch'
];

export interface InspectedTransaction {
  transaction: string;
  block: number;
  block_hash: string;
  transaction_index: number;
  log_indexes: number[];
}

export interface InspectedChunk {
  from_block: number;
  to_block: number;
  log_count: number;
}

export type OwnerBalanceCheckStatus =
  | 'evaluated'
  | 'not_applicable'
  | 'skipped'
  | 'truncated';

export interface OwnerBalanceCheck {
  status: OwnerBalanceCheckStatus;
  reason: string | null;
  owners_block_reference: number | null;
  wallets_checked: string[];
  assumptions: string[];
}

export interface ReconciliationPlan {
  consumers: TransferConsumer[];
  wallets: string[];
  enqueue_pattern: string;
  notes: string[];
}

export interface StateAuditManifest {
  manifest_version: typeof STATE_AUDIT_MANIFEST_VERSION;
  generated_at: string;
  tool: { name: 'state-audit'; mode: 'read-only' };
  status: StateAuditStatus;
  inconclusive_reasons: InconclusiveReason[];
  chain_id: number;
  contract: {
    requested: string;
    address: string | null;
    name: KnownContractName | null;
    supported: boolean;
  };
  requested_scope: {
    from_block: number;
    to_block: number;
    wallets_filter: string[];
  };
  inspected_scope: {
    from_block: number | null;
    to_block: number | null;
    blocks_inspected: number;
    complete: boolean;
    chunks: InspectedChunk[];
  };
  anchors: BlockAnchors | null;
  data_sources: string[];
  verification_assumptions: string[];
  inspected: {
    transactions: InspectedTransaction[];
    log_count: number;
    edge_count: number;
  };
  digests: {
    chain_edges: string | null;
    ledger_before_image: string | null;
  };
  ledger_before_image: { row_count: number | null };
  summary: Record<DiscrepancyType, number>;
  discrepancies: Discrepancy[];
  affected_wallets: string[];
  derived_checks: { owner_balance: OwnerBalanceCheck };
  reconciliation_plan: ReconciliationPlan;
  plan_digest: string;
}

export function emptySummary(): Record<DiscrepancyType, number> {
  const summary = {} as Record<DiscrepancyType, number>;
  DISCREPANCY_TYPES.forEach((type) => {
    summary[type] = 0;
  });
  return summary;
}

/** The portion of the manifest a later apply step must re-derive and match. */
export function planPortion(manifest: StateAuditManifest) {
  return {
    manifest_version: manifest.manifest_version,
    chain_id: manifest.chain_id,
    contract_address: manifest.contract.address,
    inspected_scope: {
      from_block: manifest.inspected_scope.from_block,
      to_block: manifest.inspected_scope.to_block,
      complete: manifest.inspected_scope.complete
    },
    anchors: manifest.anchors,
    status: manifest.status,
    digests: manifest.digests,
    discrepancies: manifest.discrepancies,
    reconciliation_plan: manifest.reconciliation_plan
  };
}

export function computePlanDigest(manifest: StateAuditManifest): string {
  return historyDigest(planPortion(manifest));
}

export function digestOf(value: unknown): string {
  return historyDigest(value);
}

export function manifestJson(manifest: StateAuditManifest): string {
  return canonicalJson(manifest);
}
