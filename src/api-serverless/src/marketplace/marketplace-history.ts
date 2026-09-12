import { ApiMarketOperationResult } from '@/api/generated/models/ApiMarketOperationResult';

const BATCH_HISTORY_PAGE_BYTES = 2 * 1024 * 1024;

/** History is navigation; opening an operation fetches its full immutable recovery evidence. */
export function marketHistoryDto(
  operation: ApiMarketOperationResult
): ApiMarketOperationResult {
  if (operation.kind !== 'BUY_BATCH') return operation;
  const {
    transaction: _transaction,
    send_attempt: _attempt,
    ...summary
  } = operation;
  return {
    ...summary,
    items: operation.items.map(({ reviewed_order: _order, ...item }) => item)
  };
}

export function marketHistoryPage(
  operations: ApiMarketOperationResult[]
): ApiMarketOperationResult[] {
  const page: ApiMarketOperationResult[] = [];
  let bytes = 0;
  for (const operation of operations) {
    const summary = marketHistoryDto(operation);
    const size = Buffer.byteLength(JSON.stringify(summary), 'utf8');
    if (page.length && bytes + size > BATCH_HISTORY_PAGE_BYTES) break;
    page.push(summary);
    bytes += size;
  }
  return page;
}
