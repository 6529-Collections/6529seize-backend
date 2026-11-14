import { getNftTransferKey } from '@/nft-transfer-edges';
import type { ChainTransfer } from './chain-transfers';
import type {
  Discrepancy,
  ExpectedLedgerRow,
  InconclusiveReason,
  LedgerRow,
  UnexpectedRowDetail
} from './state-audit.manifest';

export interface LedgerDiff {
  discrepancies: Discrepancy[];
  affected_wallets: string[];
  problems: InconclusiveReason[];
}

const MAX_SAFE_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

function edgeKey(row: {
  from_address: string;
  to_address: string;
  contract: string;
  token_id: string;
}): string {
  return getNftTransferKey(
    row.from_address,
    row.to_address,
    row.contract,
    row.token_id
  );
}

function endpointKey(row: { from_address: string; to_address: string }) {
  return `${row.from_address}:${row.to_address}`;
}

export function expectedRowOf(
  transfer: ChainTransfer,
  problems: InconclusiveReason[]
): ExpectedLedgerRow {
  if (transfer.amount > MAX_SAFE_AMOUNT) {
    problems.push({
      code: 'amount_overflow',
      detail: `transfer ${transfer.transaction} token ${transfer.token_id} moves ${transfer.amount.toString()} units, above the ledger's integer range`
    });
  }
  return {
    transaction: transfer.transaction,
    block: transfer.block,
    block_hash: transfer.block_hash,
    from_address: transfer.from_address,
    to_address: transfer.to_address,
    contract: transfer.contract,
    token_id: transfer.token_id,
    token_count: Number(transfer.amount),
    log_indexes: transfer.log_indexes
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  items.forEach((item) => {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  });
  return groups;
}

function unexpectedRow(
  stored_row: LedgerRow,
  detail: UnexpectedRowDetail
): Discrepancy {
  return {
    type: 'unexpected_row',
    transaction: stored_row.transaction,
    detail,
    stored_row,
    expected_row: null
  };
}

/** Splits stored rows into one row per normalized edge plus duplicate extras. */
function dedupeStored(stored: LedgerRow[]): {
  byKey: Map<string, LedgerRow>;
  duplicates: LedgerRow[];
} {
  const byKey = new Map<string, LedgerRow>();
  const duplicates: LedgerRow[] = [];
  stored.forEach((row) => {
    const key = edgeKey(row);
    if (byKey.has(key)) duplicates.push(row);
    else byKey.set(key, row);
  });
  return { byKey, duplicates };
}

/**
 * Pairs a stored row with the one chain edge that shares its endpoints when
 * both sides have exactly one unmatched candidate for those endpoints. Such a
 * pair is reported as a token_id_mismatch rather than a missing+unexpected pair.
 */
function pairTokenIdMismatches(
  unmatchedStored: LedgerRow[],
  unmatchedExpected: ExpectedLedgerRow[]
): {
  pairs: { stored: LedgerRow; expected: ExpectedLedgerRow }[];
  stored: LedgerRow[];
  expected: ExpectedLedgerRow[];
} {
  const storedByEndpoints = groupBy(unmatchedStored, endpointKey);
  const expectedByEndpoints = groupBy(unmatchedExpected, endpointKey);
  const pairs: { stored: LedgerRow; expected: ExpectedLedgerRow }[] = [];
  const paired = new Set<string>();
  storedByEndpoints.forEach((storedRows, endpoints) => {
    const expectedRows = expectedByEndpoints.get(endpoints) ?? [];
    if (storedRows.length === 1 && expectedRows.length === 1) {
      pairs.push({ stored: storedRows[0], expected: expectedRows[0] });
      paired.add(endpoints);
    }
  });
  return {
    pairs,
    stored: unmatchedStored.filter((row) => !paired.has(endpointKey(row))),
    expected: unmatchedExpected.filter((row) => !paired.has(endpointKey(row)))
  };
}

function diffTransaction(
  transaction: string,
  expectedRows: ExpectedLedgerRow[],
  storedRows: LedgerRow[],
  out: Discrepancy[]
): void {
  const { byKey: storedByKey, duplicates } = dedupeStored(storedRows);
  duplicates.forEach((row) =>
    out.push(unexpectedRow(row, 'duplicate_normalized_key'))
  );
  const unmatchedExpected: ExpectedLedgerRow[] = [];
  expectedRows.forEach((expected) => {
    const key = edgeKey(expected);
    const stored = storedByKey.get(key);
    if (!stored) {
      unmatchedExpected.push(expected);
      return;
    }
    storedByKey.delete(key);
    if (stored.token_count !== expected.token_count) {
      out.push({
        type: 'token_count_mismatch',
        transaction,
        stored_row: stored,
        expected_row: expected
      });
    }
  });
  const paired = pairTokenIdMismatches(
    Array.from(storedByKey.values()),
    unmatchedExpected
  );
  paired.pairs.forEach(({ stored, expected }) =>
    out.push({
      type: 'token_id_mismatch',
      transaction,
      stored_row: stored,
      expected_row: expected
    })
  );
  paired.expected.forEach((expected) =>
    out.push({
      type: 'missing_edge',
      transaction,
      stored_row: null,
      expected_row: expected
    })
  );
  paired.stored.forEach((stored) =>
    out.push(unexpectedRow(stored, 'no_chain_edge'))
  );
}

function walletsOf(discrepancy: Discrepancy): string[] {
  switch (discrepancy.type) {
    case 'missing_transaction':
      return discrepancy.expected_rows.flatMap((row) => [
        row.from_address,
        row.to_address
      ]);
    case 'owner_balance_mismatch':
      return [discrepancy.wallet];
    default: {
      const rows = [discrepancy.stored_row, discrepancy.expected_row];
      return rows.flatMap((row) =>
        row ? [row.from_address, row.to_address] : []
      );
    }
  }
}

export function affectedWalletsOf(discrepancies: Discrepancy[]): string[] {
  const wallets = new Set<string>();
  discrepancies.forEach((discrepancy) =>
    walletsOf(discrepancy).forEach((wallet) =>
      wallets.add(wallet.toLowerCase())
    )
  );
  return Array.from(wallets).sort((a, b) => a.localeCompare(b));
}

/**
 * Compares chain-derived edges with the stored ledger rows of the same scope.
 * Both inputs must already be normalized (lowercase addresses, decimal token
 * ids). Output order is deterministic for a given input order.
 */
export function diffLedger(
  chain: ChainTransfer[],
  ledger: LedgerRow[]
): LedgerDiff {
  const problems: InconclusiveReason[] = [];
  const expected = chain.map((transfer) => expectedRowOf(transfer, problems));
  const expectedByTx = groupBy(expected, (row) => row.transaction);
  const storedByTx = groupBy(ledger, (row) => row.transaction);
  const transactions = Array.from(
    new Set(
      Array.from(expectedByTx.keys()).concat(Array.from(storedByTx.keys()))
    )
  ).sort((a, b) => a.localeCompare(b));
  const discrepancies: Discrepancy[] = [];
  transactions.forEach((transaction) => {
    const expectedRows = expectedByTx.get(transaction) ?? [];
    const storedRows = storedByTx.get(transaction) ?? [];
    if (!storedRows.length) {
      discrepancies.push({
        type: 'missing_transaction',
        transaction,
        block: expectedRows[0].block,
        stored_rows: [],
        expected_rows: expectedRows
      });
    } else if (!expectedRows.length) {
      storedRows.forEach((row) =>
        discrepancies.push(unexpectedRow(row, 'no_chain_transaction'))
      );
    } else {
      diffTransaction(transaction, expectedRows, storedRows, discrepancies);
    }
  });
  return {
    discrepancies,
    affected_wallets: affectedWalletsOf(discrepancies),
    problems
  };
}
