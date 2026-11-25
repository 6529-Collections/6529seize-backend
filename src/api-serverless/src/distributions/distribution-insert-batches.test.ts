jest.mock('@/sql-executor', () => ({ sqlExecutor: { execute: jest.fn() } }));
import {
  insertDistributions,
  DistributionInsert
} from '@/api/distributions/api.distributions.db';
import { sqlExecutor } from '@/sql-executor';

const rows = Array.from(
  { length: 1001 },
  (_, index): DistributionInsert => ({
    card_id: 1,
    contract: 'contract',
    phase: 'Phase 0',
    wallet: `wallet-${index}`,
    wallet_tdh: 0,
    wallet_balance: 0,
    wallet_unique_balance: 0,
    count: 1,
    count_airdrop: 1,
    count_allowlist: 0
  })
);
beforeEach(() => jest.mocked(sqlExecutor.execute).mockReset());
afterEach(() => jest.restoreAllMocks());

it('waits for each batch on the same connection before starting the next', async () => {
  const connection = {};
  let release: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = jest
    .spyOn(sqlExecutor, 'execute')
    .mockImplementationOnce(async () => {
      await first;
      return [];
    })
    .mockResolvedValue([]);
  const operation = insertDistributions(rows, connection);
  expect(execute).toHaveBeenCalledTimes(1);
  release();
  await operation;
  expect(execute).toHaveBeenCalledTimes(3);
  expect(
    execute.mock.calls.map(
      ([, params]) =>
        Object.keys(params!).filter(
          (key) =>
            key.startsWith('wallet_') &&
            !key.startsWith('wallet_tdh_') &&
            !key.startsWith('wallet_balance_') &&
            !key.startsWith('wallet_unique_balance_')
        ).length
    )
  ).toEqual([500, 500, 1]);
  expect(
    execute.mock.calls.every(
      ([, , options]) => options?.wrappedConnection === connection
    )
  ).toBe(true);
});

it('stops before subsequent batches when a write fails', async () => {
  const execute = jest
    .spyOn(sqlExecutor, 'execute')
    .mockRejectedValueOnce(new Error('write failed'));
  await expect(insertDistributions(rows, {})).rejects.toThrow('write failed');
  expect(execute).toHaveBeenCalledTimes(1);
});
