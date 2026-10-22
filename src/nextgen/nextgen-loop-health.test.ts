import { findNextGenTransactions } from './nextgen';
import { getDataSource } from '@/db';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { fetchNextGenLatestBlock } from './nextgen.db';
import { processPendingMetadataTokens } from './nextgen_pending_metadata';
import { NextgenLoopHealth } from '@/nextgenContractLoop/loop-health';
import { reportLoopHealth } from '@/loop-health';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('@/alchemy-sdk', () => ({ Alchemy: jest.fn() }));
jest.mock('@/ethereum-rpc/ethereum-rpc-client');
jest.mock('./nextgen.db');
jest.mock('./nextgen_core_events');
jest.mock('./nextgen_core_transactions');
jest.mock('./nextgen_minter');
jest.mock('./nextgen_pending_metadata');
jest.mock('./nextgen_pending_mint_data');
jest.mock('./nextgen_tokens');
jest.mock('./nextgen_pending_thumbnails');
jest.mock('@/loop-health');
jest.mock('@/loop-health-read');

const report = jest.mocked(reportLoopHealth);
const transaction = jest.fn();
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
  jest.mocked(getDataSource).mockReturnValue({ transaction } as never);
  jest.mocked(getEthereumRpcClient).mockReturnValue({
    getBlockNumber: jest.fn().mockResolvedValue(100),
    getBlock: jest.fn().mockResolvedValue({ timestamp: 1900 })
  } as never);
  jest.mocked(fetchNextGenLatestBlock).mockResolvedValue(90);
  transaction.mockImplementation(async (_isolation, action) => action({}));
});
afterEach(() => jest.restoreAllMocks());

it('emits indexing progress only after transaction commit', async () => {
  transaction.mockImplementation(async (_isolation, action) => {
    const result = await action({});
    expect(report.mock.calls.some(([v]) => v.progressAt !== undefined)).toBe(
      false
    );
    return result;
  });
  await findNextGenTransactions(new NextgenLoopHealth());
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'indexing',
      pending: false,
      progressAt: 2000,
      watermarkAt: 1900
    })
  );
});

it('does not emit committed progress or recovery after a rollback', async () => {
  transaction.mockImplementation(async (_isolation, action) => {
    await action({});
    throw new Error('rollback');
  });
  await expect(
    findNextGenTransactions(new NextgenLoopHealth())
  ).rejects.toThrow('rollback');
  expect(
    report.mock.calls.some(
      ([v]) => v.progressAt !== undefined || v.pending === false
    )
  ).toBe(false);
});

it('does not let an advancing index hide internally handled enrichment failures', async () => {
  jest
    .mocked(processPendingMetadataTokens)
    .mockImplementation(async (_manager, incomplete) => {
      incomplete?.();
    });
  await findNextGenTransactions(new NextgenLoopHealth());
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ operation: 'indexing', pending: false })
  );
  expect(report).toHaveBeenLastCalledWith({
    operation: 'recalculation',
    pending: true,
    recovery: 'unknown'
  });
});

it('keeps a capped block scan pending and does not claim enrichment completed', async () => {
  jest.mocked(getEthereumRpcClient).mockReturnValue({
    getBlockNumber: jest.fn().mockResolvedValue(200_100),
    getBlock: jest.fn().mockResolvedValue({ timestamp: 1900 })
  } as never);
  await findNextGenTransactions(new NextgenLoopHealth());
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({
      operation: 'indexing',
      pending: true,
      oldestPendingAt: 1900
    })
  );
  expect(processPendingMetadataTokens).not.toHaveBeenCalled();
});
