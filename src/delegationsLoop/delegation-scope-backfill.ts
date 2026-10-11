import { DELEGATIONS_IFACE } from '@/abis/delegations';
import type { Log } from '@/alchemy-sdk';
import {
  DELEGATION_CONTRACT,
  DELEGATION_CONTRACT_DEPLOYMENT_BLOCK,
  NEVER_DATE,
  USE_CASE_CONSOLIDATION
} from '@/constants';
import type { DelegationEvent } from '@/entities/IDelegation';
import { Logger } from '@/logging';
import { mapInChunks } from '@/map-in-chunks';

// One-off re-index of the delegations table (every use case except
// consolidation, 999) after the expiry / token-scope fix. It recomputes the
// rows the delegations loop would have stored for the scanned range and
// writes only the difference. Nothing else runs: no consolidation, ENS, TDH,
// profile or primary-address work, and the nftdelegation_blocks checkpoint
// stays where it is. Operators remove the flag after one run.

const logger = Logger.get('DELEGATIONS_SCOPE_BACKFILL');

export const SCOPE_BACKFILL_FLAG = 'DELEGATIONS_SCOPE_BACKFILL';
export const SCOPE_BACKFILL_FROM_BLOCK_FLAG =
  'DELEGATIONS_SCOPE_BACKFILL_FROM_BLOCK';

const LOGGED_ROW_DIFFS = 25;
const TRANSACTION_READ_CONCURRENCY = 5;

export type ScopeBackfillMode = 'dry-run' | 'apply';

export interface ScopeBackfillConfig {
  mode: ScopeBackfillMode;
  fromBlock: number;
}

/** A delegations row, normalised for comparison. */
export interface DelegationRow {
  block: number;
  from_address: string;
  to_address: string;
  collection: string;
  use_case: number;
  expiry: number;
  all_tokens: boolean;
  token_id: number;
}

export type ScopeField = 'expiry' | 'all_tokens' | 'token_id';

const SCOPE_FIELDS: ScopeField[] = ['expiry', 'all_tokens', 'token_id'];

export interface RowUpdate {
  current: DelegationRow;
  expected: DelegationRow;
  fields: ScopeField[];
}

export interface DelegationRowDiff {
  inserts: DelegationRow[];
  deletes: DelegationRow[];
  updates: RowUpdate[];
  unchanged: number;
}

export type ChangeCause =
  | 'contract-wallet'
  | 'batch'
  | 'token-specific'
  | 'revoked-same-block'
  | 'not-in-chain-history'
  | 'other';

export interface ScopeBackfillReport {
  mode: ScopeBackfillMode;
  fromBlock: number;
  toBlock: number;
  logs: number;
  diff: DelegationRowDiff;
  causes: Record<ChangeCause, number>;
  /** Rows active now (expiry >= now) that the diff would make inactive. */
  deactivates: number;
  /** Rows inactive or missing now that the diff would make active. */
  activates: number;
  applied: boolean;
}

export interface ScopeBackfillScan {
  logs: Log[];
  registrations: DelegationEvent[];
  revocations: DelegationEvent[];
}

export interface ScopeBackfillDeps {
  /** MAX(nftdelegation_blocks.block): the last block the loop processed. */
  latestProcessedBlock(): Promise<number>;
  scan(fromBlock: number, toBlock: number): Promise<ScopeBackfillScan>;
  /** Every delegations row except use case 999. */
  readRows(): Promise<DelegationRow[]>;
  getTransaction(
    hash: string
  ): Promise<{ to: string | null; data: string } | null>;
  /** Writes the whole diff in one transaction. */
  applyDiff(diff: DelegationRowDiff): Promise<void>;
  /** Unix seconds, for the active/inactive counts in the report. */
  nowSeconds(): number;
}

export function readScopeBackfillConfig(
  env: NodeJS.ProcessEnv = process.env
): ScopeBackfillConfig | null {
  const mode = env[SCOPE_BACKFILL_FLAG]?.trim();
  if (!mode) {
    return null;
  }
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new Error(
      `${SCOPE_BACKFILL_FLAG} must be "dry-run" or "apply", got "${mode}"`
    );
  }
  const fromBlock = env[SCOPE_BACKFILL_FROM_BLOCK_FLAG]?.trim();
  if (fromBlock && !/^\d+$/.test(fromBlock)) {
    throw new Error(
      `${SCOPE_BACKFILL_FROM_BLOCK_FLAG} must be a block number, got "${fromBlock}"`
    );
  }
  return {
    mode,
    fromBlock: fromBlock
      ? Number(fromBlock)
      : DELEGATION_CONTRACT_DEPLOYMENT_BLOCK
  };
}

export function rowKey(row: {
  block: number;
  from_address: string;
  to_address: string;
  collection: string;
  use_case: number;
}): string {
  return [row.block, pairKey(row)].join('|');
}

function pairKey(row: {
  from_address: string;
  to_address: string;
  collection: string;
  use_case: number;
}): string {
  return [
    row.from_address.toLowerCase(),
    row.to_address.toLowerCase(),
    row.collection.toLowerCase(),
    row.use_case
  ].join('|');
}

function eventPairKey(event: DelegationEvent): string {
  return pairKey({
    from_address: event.wallet1,
    to_address: event.wallet2,
    collection: event.collection,
    use_case: event.use_case
  });
}

/** The row the delegations loop stores for a registration event. */
export function rowFromRegistration(event: DelegationEvent): DelegationRow {
  return {
    block: event.block,
    from_address: event.wallet1,
    to_address: event.wallet2,
    collection: event.collection,
    use_case: event.use_case,
    expiry: event.expiry ?? NEVER_DATE,
    all_tokens: event.all_tokens ?? true,
    token_id: event.token_id ?? 0
  };
}

/**
 * The rows the delegations loop would hold for blocks up to the end of the
 * scan: rows before `fromBlock` as they are, plus every scanned registration
 * (the last one wins on a shared key), minus every row that a revocation in
 * a later block removed.
 */
export function buildExpectedRows(input: {
  fromBlock: number;
  currentRows: DelegationRow[];
  registrations: DelegationEvent[];
  revocations: DelegationEvent[];
}): DelegationRow[] {
  const rows = new Map<string, DelegationRow>();
  for (const row of input.currentRows) {
    if (row.block < input.fromBlock) {
      rows.set(rowKey(row), row);
    }
  }
  for (const registration of input.registrations) {
    const row = rowFromRegistration(registration);
    const key = rowKey(row);
    rows.delete(key);
    rows.set(key, row);
  }
  const lastRevocation = new Map<string, number>();
  for (const revocation of input.revocations) {
    const key = eventPairKey(revocation);
    lastRevocation.set(
      key,
      Math.max(lastRevocation.get(key) ?? -1, revocation.block)
    );
  }
  return Array.from(rows.values()).filter(
    (row) => (lastRevocation.get(pairKey(row)) ?? -1) <= row.block
  );
}

/** Compares rows by primary key. Use case 999 rows are never compared. */
export function diffDelegationRows(
  current: DelegationRow[],
  expected: DelegationRow[]
): DelegationRowDiff {
  const notConsolidation = (row: DelegationRow) =>
    row.use_case !== USE_CASE_CONSOLIDATION;
  const currentByKey = new Map(
    current.filter(notConsolidation).map((row) => [rowKey(row), row])
  );
  const expectedByKey = new Map(
    expected.filter(notConsolidation).map((row) => [rowKey(row), row])
  );
  const diff: DelegationRowDiff = {
    inserts: [],
    deletes: [],
    updates: [],
    unchanged: 0
  };
  for (const [key, row] of Array.from(expectedByKey.entries())) {
    const existing = currentByKey.get(key);
    if (!existing) {
      diff.inserts.push(row);
      continue;
    }
    const fields = SCOPE_FIELDS.filter(
      (field) => existing[field] !== row[field]
    );
    if (fields.length > 0) {
      diff.updates.push({ current: existing, expected: row, fields });
    } else {
      diff.unchanged++;
    }
  }
  for (const [key, row] of Array.from(currentByKey.entries())) {
    if (!expectedByKey.has(key)) {
      diff.deletes.push(row);
    }
  }
  return diff;
}

export function hasChanges(diff: DelegationRowDiff): boolean {
  return diff.inserts.length + diff.deletes.length + diff.updates.length > 0;
}

interface LogIndex {
  registrationTx: Map<string, string>;
  revokedInBlock: Set<string>;
}

// Registration transaction per row key, and the row keys revoked in their
// own block, from the scanned logs.
function indexLogs(logs: Log[]): LogIndex {
  const index: LogIndex = {
    registrationTx: new Map(),
    revokedInBlock: new Set()
  };
  for (const log of logs) {
    const parsed = DELEGATIONS_IFACE.parseLog(log);
    // UpdateDelegation also emits a Revoke and a Register log; skip it.
    if (
      !parsed ||
      !(parsed.name.startsWith('Register') || parsed.name.startsWith('Revoke'))
    ) {
      continue;
    }
    const key = rowKey({
      block: log.blockNumber,
      from_address: parsed.args.delegator
        ? parsed.args.delegator
        : parsed.args.from,
      to_address: parsed.args.delegationAddress,
      collection: parsed.args.collectionAddress,
      use_case: Number(parsed.args.useCase)
    });
    if (parsed.name.startsWith('Register')) {
      index.registrationTx.set(key, log.transactionHash);
    } else if (parsed.name.startsWith('Revoke')) {
      index.revokedInBlock.add(key);
    }
  }
  return index;
}

async function classifyChanges(
  diff: DelegationRowDiff,
  logs: Log[],
  getTransaction: ScopeBackfillDeps['getTransaction']
): Promise<Record<ChangeCause, number>> {
  const causes: Record<ChangeCause, number> = {
    'contract-wallet': 0,
    batch: 0,
    'token-specific': 0,
    'revoked-same-block': 0,
    'not-in-chain-history': 0,
    other: 0
  };
  const index = indexLogs(logs);
  const written = [
    ...diff.inserts,
    ...diff.updates.map((update) => update.expected)
  ];
  const hashes = Array.from(
    new Set(
      written
        .map((row) => index.registrationTx.get(rowKey(row)))
        .filter((hash): hash is string => hash !== undefined)
    )
  );
  const transactions = await mapInChunks(
    hashes,
    TRANSACTION_READ_CONCURRENCY,
    async (hash): Promise<[string, SignerTransaction]> => {
      const tx = await getTransaction(hash);
      if (!tx) {
        throw new Error(`Transaction ${hash} not found`);
      }
      return [hash, tx];
    }
  );
  const byHash = new Map(transactions);

  for (const row of written) {
    const hash = index.registrationTx.get(rowKey(row));
    for (const cause of writtenRowCauses(
      row,
      hash ? byHash.get(hash) : undefined
    )) {
      causes[cause]++;
    }
  }
  for (const row of diff.deletes) {
    causes[deletedRowCause(row, index)]++;
  }
  return causes;
}

type SignerTransaction = { to: string | null; data: string };

function writtenRowCauses(
  row: DelegationRow,
  tx: SignerTransaction | undefined
): ChangeCause[] {
  const causes: ChangeCause[] = [];
  if (tx) {
    const toContract =
      tx.to?.toLowerCase() === DELEGATION_CONTRACT.contract.toLowerCase();
    if (!toContract) {
      causes.push('contract-wallet');
    } else if (
      DELEGATIONS_IFACE.parseTransaction({ data: tx.data })?.name ===
      'batchDelegations'
    ) {
      causes.push('batch');
    }
  }
  if (!row.all_tokens) {
    causes.push('token-specific');
  }
  return causes.length > 0 ? causes : ['other'];
}

function deletedRowCause(row: DelegationRow, index: LogIndex): ChangeCause {
  const key = rowKey(row);
  if (index.revokedInBlock.has(key)) {
    return 'revoked-same-block';
  }
  return index.registrationTx.has(key) ? 'other' : 'not-in-chain-history';
}

function describeRow(row: DelegationRow): string {
  return `block ${row.block} ${row.from_address} -> ${row.to_address} collection ${row.collection} use case ${row.use_case} (expiry ${row.expiry}, all_tokens ${row.all_tokens}, token_id ${row.token_id})`;
}

// Readers treat a delegation as active while expiry >= now.
const isActive = (row: DelegationRow | undefined, now: number) =>
  row !== undefined && row.expiry >= now;

function countActivity(
  diff: DelegationRowDiff,
  now: number
): { deactivates: number; activates: number } {
  const changes: [DelegationRow | undefined, DelegationRow | undefined][] = [
    ...diff.updates.map((u): [DelegationRow, DelegationRow] => [
      u.current,
      u.expected
    ]),
    ...diff.inserts.map((row): [undefined, DelegationRow] => [undefined, row]),
    ...diff.deletes.map((row): [DelegationRow, undefined] => [row, undefined])
  ];
  let deactivates = 0;
  let activates = 0;
  for (const [before, after] of changes) {
    if (isActive(before, now) && !isActive(after, now)) {
      deactivates++;
    } else if (!isActive(before, now) && isActive(after, now)) {
      activates++;
    }
  }
  return { deactivates, activates };
}

function logReport(report: ScopeBackfillReport, now: number) {
  const { diff } = report;
  logger.info(
    `[${report.mode.toUpperCase()}] [BLOCKS ${report.fromBlock}-${report.toBlock}] [LOGS ${report.logs}] [INSERT ${diff.inserts.length}] [DELETE ${diff.deletes.length}] [UPDATE ${diff.updates.length}] [UNCHANGED ${diff.unchanged}] [DEACTIVATES ${report.deactivates}] [ACTIVATES ${report.activates}] [CAUSES ${JSON.stringify(report.causes)}]`
  );
  const tag = (before: DelegationRow | undefined, after?: DelegationRow) =>
    isActive(before, now) && !isActive(after, now) ? ' [DEACTIVATES]' : '';
  const lines = [
    ...diff.updates.map(
      (u) =>
        `[UPDATE]${tag(u.current, u.expected)} ${describeRow(u.current)} -> ${u.fields
          .map(
            (field) => `${field} ${u.current[field]} => ${u.expected[field]}`
          )
          .join(', ')}`
    ),
    ...diff.inserts.map((row) => `[INSERT] ${describeRow(row)}`),
    ...diff.deletes.map((row) => `[DELETE]${tag(row)} ${describeRow(row)}`)
  ];
  lines.slice(0, LOGGED_ROW_DIFFS).forEach((line) => logger.info(line));
  if (lines.length > LOGGED_ROW_DIFFS) {
    logger.info(`[${lines.length - LOGGED_ROW_DIFFS} MORE ROW CHANGES]`);
  }
}

/**
 * Re-indexes delegations from `config.fromBlock` up to the last block the
 * loop has processed. Dry-run only reports; apply writes the diff in one
 * transaction. Any read failure throws before anything is written.
 */
export async function runDelegationScopeBackfill(
  config: ScopeBackfillConfig,
  deps: ScopeBackfillDeps
): Promise<ScopeBackfillReport> {
  const toBlock = Number(await deps.latestProcessedBlock());
  if (!toBlock || toBlock < config.fromBlock) {
    throw new Error(
      `No processed delegation blocks at or after ${config.fromBlock} (last processed ${toBlock})`
    );
  }
  logger.info(
    `[START] [${config.mode.toUpperCase()}] [FROM BLOCK ${config.fromBlock}] [TO BLOCK ${toBlock}]`
  );
  const scan = await deps.scan(config.fromBlock, toBlock);
  // Rows after the last processed block belong to the normal loop.
  const currentRows = (await deps.readRows()).filter(
    (row) => row.block <= toBlock
  );
  const expected = buildExpectedRows({
    fromBlock: config.fromBlock,
    currentRows,
    registrations: scan.registrations,
    revocations: scan.revocations
  });
  const diff = diffDelegationRows(currentRows, expected);
  const causes = await classifyChanges(diff, scan.logs, deps.getTransaction);
  const apply = config.mode === 'apply' && hasChanges(diff);
  const now = deps.nowSeconds();
  const report: ScopeBackfillReport = {
    mode: config.mode,
    fromBlock: config.fromBlock,
    toBlock,
    logs: scan.logs.length,
    diff,
    causes,
    ...countActivity(diff, now),
    applied: apply
  };
  logReport(report, now);
  if (apply) {
    await deps.applyDiff(diff);
    logger.info(`[APPLIED]`);
  } else {
    logger.info(`[NOTHING WRITTEN]`);
  }
  return report;
}
