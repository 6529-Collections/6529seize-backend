import { NULL_ADDRESS } from '@/constants';
import { canonicalJson } from '@/nft-history/canonical-json';
import { getNftTransferKey } from '@/nft-transfer-edges';
import { compareLedgerRows } from './state-audit.db';
import {
  computePlanDigest,
  Discrepancy,
  DISCREPANCY_TYPES,
  ExpectedLedgerRow,
  LedgerRow,
  STATE_AUDIT_MANIFEST_VERSION,
  StateAuditManifest
} from './state-audit.manifest';
import { resolveAuditContract } from './state-audit.service';

export type ApplyRejectionCode =
  | 'apply_disabled'
  | 'manifest_invalid'
  | 'manifest_unsupported'
  | 'manifest_not_applicable'
  | 'manifest_stale'
  | 'plan_digest_mismatch'
  | 'unsupported_contract'
  | 'chain_id_mismatch'
  | 'unsupported_discrepancy'
  | 'plan_inconsistent'
  | 'job_digest_mismatch'
  | 'job_failed'
  | 'job_cursor_changed'
  | 'stale_chain'
  | 'stale_database'
  | 'plan_mismatch'
  | 'rpc_error'
  | 'database_error';

/** A fail-closed refusal. Nothing has been written when one is thrown. */
export class ApplyRejection extends Error {
  constructor(
    readonly code: ApplyRejectionCode,
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type LedgerDiscrepancy = Exclude<
  Discrepancy,
  { type: 'owner_balance_mismatch' }
>;

export type RepairAction =
  | {
      action: 'insert';
      reason: 'missing_transaction' | 'missing_edge';
      row: ExpectedLedgerRow;
    }
  | { action: 'update_token_count'; stored_row: LedgerRow; token_count: number }
  | {
      action: 'replace_token_id';
      stored_row: LedgerRow;
      row: ExpectedLedgerRow;
    }
  | {
      action: 'delete';
      reason: 'no_chain_transaction' | 'no_chain_edge';
      stored_row: LedgerRow;
    };

/** One transaction hash's corrections; applied in one database transaction. */
export interface RepairUnit {
  index: number;
  transaction: string;
  block: number;
  actions: RepairAction[];
  /** Every ledger row of the transaction before the unit, from the before-image. */
  before_rows: LedgerRow[];
  /** The rows the transaction must hold after the unit. */
  after_rows: LedgerRow[];
  /** Endpoints of before and after rows to enqueue, zero address excluded. */
  wallets: string[];
  excluded_wallets: string[];
}

export interface ManifestValidationOptions {
  planDigest: string;
  chainId: number;
  now: Date;
  maxManifestAgeHours: number;
}

function reject(code: ApplyRejectionCode, message: string): never {
  throw new ApplyRejection(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAnchor(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.number) &&
    typeof value.hash === 'string'
  );
}

function requireShape(raw: unknown): StateAuditManifest {
  if (!isRecord(raw)) {
    return reject('manifest_invalid', 'manifest is not a JSON object');
  }
  if (raw.manifest_version !== STATE_AUDIT_MANIFEST_VERSION) {
    return reject(
      'manifest_unsupported',
      `manifest_version ${String(raw.manifest_version)} is not supported; expected ${STATE_AUDIT_MANIFEST_VERSION}`
    );
  }
  const contract = raw.contract;
  const anchors = raw.anchors;
  const scope = raw.inspected_scope;
  const digests = raw.digests;
  const beforeImage = raw.ledger_before_image;
  const valid =
    typeof raw.plan_digest === 'string' &&
    typeof raw.status === 'string' &&
    typeof raw.generated_at === 'string' &&
    Number.isSafeInteger(raw.chain_id) &&
    isRecord(contract) &&
    isRecord(anchors) &&
    isAnchor(anchors.from_block) &&
    isAnchor(anchors.to_block) &&
    isAnchor(anchors.finalized) &&
    isRecord(scope) &&
    Number.isSafeInteger(scope.from_block) &&
    Number.isSafeInteger(scope.to_block) &&
    isRecord(digests) &&
    isRecord(beforeImage) &&
    Array.isArray(raw.discrepancies) &&
    Array.isArray(raw.inconclusive_reasons);
  if (!valid) {
    return reject('manifest_invalid', 'manifest is missing required fields');
  }
  const unknownType = (raw.discrepancies as unknown[]).find(
    (entry) =>
      !isRecord(entry) ||
      !(DISCREPANCY_TYPES as readonly unknown[]).includes(entry.type)
  );
  if (unknownType !== undefined) {
    return reject(
      'manifest_invalid',
      'manifest contains a discrepancy of unknown type'
    );
  }
  return raw as unknown as StateAuditManifest;
}

function requireFresh(
  manifest: StateAuditManifest,
  options: ManifestValidationOptions
): void {
  const generated = Date.parse(manifest.generated_at);
  if (Number.isNaN(generated)) {
    reject('manifest_invalid', 'generated_at is not a valid timestamp');
  }
  const ageHours = (options.now.getTime() - generated) / 3_600_000;
  if (ageHours > options.maxManifestAgeHours) {
    reject(
      'manifest_stale',
      `manifest was generated ${ageHours.toFixed(1)} hours ago, above the ${options.maxManifestAgeHours}-hour limit; rerun the audit`
    );
  }
}

/**
 * Structural, digest, status, contract, chain and age checks. Returns the
 * typed manifest or throws an {@link ApplyRejection}. No I/O.
 */
export function validateApplyManifest(
  raw: unknown,
  options: ManifestValidationOptions
): StateAuditManifest {
  const manifest = requireShape(raw);
  const recomputed = computePlanDigest(manifest);
  if (recomputed !== manifest.plan_digest) {
    reject(
      'plan_digest_mismatch',
      'the manifest content does not match its plan_digest; the file was edited after the audit'
    );
  }
  if (recomputed !== options.planDigest) {
    reject(
      'plan_digest_mismatch',
      `--plan-digest ${options.planDigest} does not match the manifest's plan_digest ${recomputed}`
    );
  }
  if (manifest.status !== 'differences_found') {
    reject(
      'manifest_not_applicable',
      manifest.status === 'clean'
        ? 'manifest status is clean; there is nothing to apply'
        : `manifest status is ${manifest.status}; only differences_found manifests can be applied`
    );
  }
  if (
    manifest.inconclusive_reasons.length ||
    !manifest.inspected_scope.complete
  ) {
    reject('manifest_not_applicable', 'manifest is not conclusive');
  }
  const address = manifest.contract.address;
  if (!manifest.contract.supported || typeof address !== 'string') {
    reject('unsupported_contract', 'manifest contract is not supported');
  }
  const resolution = resolveAuditContract(address as string);
  if (!resolution.supported) {
    reject('unsupported_contract', resolution.reason);
  }
  if (manifest.chain_id !== options.chainId) {
    reject(
      'chain_id_mismatch',
      `manifest chain ${manifest.chain_id} but the RPC client is configured for chain ${options.chainId}`
    );
  }
  if (
    manifest.digests.ledger_before_image === null ||
    manifest.ledger_before_image.row_count === null
  ) {
    reject('manifest_invalid', 'manifest has no ledger before-image digest');
  }
  requireFresh(manifest, options);
  return manifest;
}

export function ledgerDiscrepanciesOf(
  manifest: Pick<StateAuditManifest, 'discrepancies'>
): LedgerDiscrepancy[] {
  return manifest.discrepancies.filter(
    (entry): entry is LedgerDiscrepancy =>
      entry.type !== 'owner_balance_mismatch'
  );
}

export function stripExpectedRow(row: ExpectedLedgerRow): LedgerRow {
  return {
    transaction: row.transaction,
    block: row.block,
    from_address: row.from_address,
    to_address: row.to_address,
    contract: row.contract,
    token_id: row.token_id,
    token_count: row.token_count
  };
}

function rowKey(row: LedgerRow): string {
  return getNftTransferKey(
    row.from_address,
    row.to_address,
    row.contract,
    row.token_id
  );
}

function actionsOf(discrepancy: LedgerDiscrepancy): RepairAction[] {
  switch (discrepancy.type) {
    case 'missing_transaction':
      return discrepancy.expected_rows.map((row) => ({
        action: 'insert',
        reason: 'missing_transaction',
        row
      }));
    case 'missing_edge':
      return [
        {
          action: 'insert',
          reason: 'missing_edge',
          row: discrepancy.expected_row
        }
      ];
    case 'token_count_mismatch':
      return [
        {
          action: 'update_token_count',
          stored_row: discrepancy.stored_row,
          token_count: discrepancy.expected_row.token_count
        }
      ];
    case 'token_id_mismatch':
      return [
        {
          action: 'replace_token_id',
          stored_row: discrepancy.stored_row,
          row: discrepancy.expected_row
        }
      ];
    case 'unexpected_row':
      if (discrepancy.detail === 'duplicate_normalized_key') {
        return reject(
          'unsupported_discrepancy',
          `transaction ${discrepancy.transaction} has a case-variant duplicate row; the manifest does not carry the raw key, so it must be repaired by hand`
        );
      }
      return [
        {
          action: 'delete',
          reason: discrepancy.detail,
          stored_row: discrepancy.stored_row
        }
      ];
  }
}

function removeStored(
  rows: Map<string, LedgerRow>,
  stored: LedgerRow,
  transaction: string
): void {
  const key = rowKey(stored);
  const current = rows.get(key);
  if (!current || canonicalJson(current) !== canonicalJson(stored)) {
    reject(
      'plan_inconsistent',
      `transaction ${transaction}: the manifest's stored row is not in the ledger before-image`
    );
  }
  rows.delete(key);
}

function addExpected(
  rows: Map<string, LedgerRow>,
  expected: ExpectedLedgerRow,
  transaction: string
): void {
  const row = stripExpectedRow(expected);
  if (rows.has(rowKey(row))) {
    reject(
      'plan_inconsistent',
      `transaction ${transaction}: the manifest inserts a row the ledger before-image already holds`
    );
  }
  rows.set(rowKey(row), row);
}

function applyActions(
  transaction: string,
  before: LedgerRow[],
  actions: RepairAction[]
): LedgerRow[] {
  const rows = new Map<string, LedgerRow>();
  before.forEach((row) => rows.set(rowKey(row), row));
  actions.forEach((action) => {
    switch (action.action) {
      case 'insert':
        addExpected(rows, action.row, transaction);
        break;
      case 'update_token_count':
        removeStored(rows, action.stored_row, transaction);
        rows.set(rowKey(action.stored_row), {
          ...action.stored_row,
          token_count: action.token_count
        });
        break;
      case 'replace_token_id':
        removeStored(rows, action.stored_row, transaction);
        addExpected(rows, action.row, transaction);
        break;
      case 'delete':
        removeStored(rows, action.stored_row, transaction);
        break;
    }
  });
  return Array.from(rows.values()).sort(compareLedgerRows);
}

function walletsOf(rows: LedgerRow[]): {
  wallets: string[];
  excluded_wallets: string[];
} {
  const zero = NULL_ADDRESS.toLowerCase();
  const all = new Set<string>();
  rows.forEach((row) => {
    all.add(row.from_address.toLowerCase());
    all.add(row.to_address.toLowerCase());
  });
  const sorted = Array.from(all).sort((a, b) => a.localeCompare(b));
  return {
    wallets: sorted.filter((wallet) => wallet !== zero),
    excluded_wallets: sorted.filter((wallet) => wallet === zero)
  };
}

function groupByTransaction<T extends { transaction: string }>(
  items: T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  items.forEach((item) => {
    const group = groups.get(item.transaction);
    if (group) group.push(item);
    else groups.set(item.transaction, [item]);
  });
  return groups;
}

/**
 * Derives the ordered repair units from the manifest's ledger discrepancies
 * and the ledger before-image. Deterministic for a given manifest and image;
 * the same inputs on a rerun yield the same units and indexes.
 */
export function buildRepairUnits(
  discrepancies: Discrepancy[],
  beforeImage: LedgerRow[]
): RepairUnit[] {
  const byTransaction = groupByTransaction(
    ledgerDiscrepanciesOf({ discrepancies })
  );
  const imageByTransaction = groupByTransaction(beforeImage);
  return Array.from(byTransaction.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((transaction, index) => {
      const actions = byTransaction
        .get(transaction)!
        .flatMap((discrepancy) => actionsOf(discrepancy));
      const before = (imageByTransaction.get(transaction) ?? [])
        .slice()
        .sort(compareLedgerRows);
      const after = applyActions(transaction, before, actions);
      const block = (after[0] ?? before[0]).block;
      return {
        index,
        transaction,
        block,
        actions,
        before_rows: before,
        after_rows: after,
        ...walletsOf(before.concat(after))
      };
    });
}

/**
 * The ledger rows the window must hold once the units before `nextIndex`
 * are applied and nothing else changed. With `nextIndex` 0 this is the
 * before-image itself.
 */
export function expectedLedgerImage(
  beforeImage: LedgerRow[],
  units: RepairUnit[],
  nextIndex: number
): LedgerRow[] {
  const applied = new Map<string, LedgerRow[]>();
  units
    .filter((unit) => unit.index < nextIndex)
    .forEach((unit) => applied.set(unit.transaction, unit.after_rows));
  const rows = beforeImage.filter((row) => !applied.has(row.transaction));
  applied.forEach((afterRows) => afterRows.forEach((row) => rows.push(row)));
  return rows.sort(compareLedgerRows);
}

export function planTransactions(units: RepairUnit[]): string[] {
  return units.map((unit) => unit.transaction);
}
