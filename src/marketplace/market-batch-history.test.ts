import { MarketOperationsDb } from '@/marketplace/market-operations.db';
import type { SqlExecutor } from '@/sql-executor';
import {
  marketHistoryDto,
  marketHistoryPage
} from '@/api/marketplace/marketplace-history';
import {
  ApiMarketBatchOperation,
  ApiMarketBatchOperationKindEnum
} from '@/api/generated/models/ApiMarketBatchOperation';

test('legacy history excludes batches before pagination; explicit opt-in preserves actor scope and cursor', async () => {
  const execute = jest.fn().mockResolvedValue([]);
  const db = new MarketOperationsDb(
    () => ({ execute }) as unknown as SqlExecutor
  );
  const cursor = { created_at: 123, id: 'cursor' };
  await db.page('profile', 20, cursor, '0xABC');
  expect(execute.mock.calls[0][0]).toContain(
    "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(request_json, '$.kind')), '') <> 'BUY_BATCH'"
  );
  await db.page('profile', 20, cursor, '0xABC', true);
  const [sql, params] = execute.mock.calls[1];
  expect(sql).not.toContain('BUY_BATCH');
  expect(sql).toContain('(profile_id=:profileId OR wallet=:wallet)');
  expect(sql).toContain(
    'AND (created_at<:createdAt OR (created_at=:createdAt AND id<:id))'
  );
  expect(params).toEqual({
    profileId: 'profile',
    wallet: '0xabc',
    limit: 21,
    createdAt: 123,
    id: 'cursor'
  });
});

test('batch history omits execution authorizations and components and paginates before response growth', () => {
  const operation = {
    id: 'batch',
    kind: ApiMarketBatchOperationKindEnum.BuyBatch,
    transaction: { data: 'synthetic-authorization' },
    send_attempt: { transaction: { data: 'synthetic-authorization' } },
    items: [
      {
        asset_key: 'asset',
        reviewed_order: { signature: 'synthetic-authorization' },
        allocations: []
      }
    ]
  } as unknown as ApiMarketBatchOperation;
  expect(marketHistoryDto(operation)).toEqual({
    id: 'batch',
    kind: 'BUY_BATCH',
    items: [{ asset_key: 'asset', allocations: [] }]
  });
  expect(JSON.stringify(marketHistoryDto(operation))).not.toContain(
    'synthetic-authorization'
  );
  const large = {
    ...operation,
    items: Array.from({ length: 128 }, () => ({
      ...operation.items[0],
      asset_key: 'a'.repeat(120),
      allocations: Array.from({ length: 2 }, () => ({
        recipient: `0x${'1'.repeat(40)}`,
        quantity: '1',
        acknowledge_external_recipient: false
      }))
    }))
  };
  const page = marketHistoryPage(
    Array.from({ length: 100 }, (_, index) => ({ ...large, id: String(index) }))
  );
  expect(page.length).toBeGreaterThan(1);
  expect(page.length).toBeLessThan(100);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(
    2 * 1024 * 1024 + page.length + 2
  );
  expect(page.at(-1)?.id).toBe(String(page.length - 1));
});
