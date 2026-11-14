import { JsonRpcProvider } from 'ethers';
import { sqlExecutor } from '@/sql-executor';
import { transactionsDb } from './transactions.discovery.db';
import { checkpointTransactionScan } from './transaction-scan-checkpoint';
jest.mock('@/sql-executor', () => ({
  ...jest.requireActual<typeof import('@/sql-executor')>('@/sql-executor'),
  sqlExecutor: { oneOrNull: jest.fn(), execute: jest.fn() }
}));
jest.mock('./transactions.discovery.db', () => ({
  transactionsDb: { getLatestTransactionsBlockForContract: jest.fn() }
}));
const hash = '0x' + 'b'.repeat(64);
function fixture() {
  const provider = {
    getBlock: jest.fn().mockResolvedValue({ number: 100, hash })
  };
  const scan = jest.fn().mockResolvedValue(undefined);
  return {
    provider,
    scan,
    run: () =>
      checkpointTransactionScan(
        1,
        'contract',
        provider as unknown as JsonRpcProvider,
        scan
      )
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(sqlExecutor.oneOrNull).mockResolvedValue(null);
  jest.mocked(sqlExecutor.execute).mockResolvedValue([]);
  jest
    .mocked(transactionsDb.getLatestTransactionsBlockForContract)
    .mockResolvedValue(90);
});
it('advances across empty blocks only after the bounded scan succeeds', async () => {
  const f = fixture();
  await f.run();
  expect(f.scan).toHaveBeenCalledWith(91, 100);
  expect(sqlExecutor.execute).toHaveBeenCalledWith(
    expect.stringContaining('GREATEST'),
    expect.objectContaining({ block: 100, hash })
  );
});
it('continues from durable coverage even when the most recent transfer is much earlier', async () => {
  jest
    .mocked(sqlExecutor.oneOrNull)
    .mockResolvedValue({ block: 98, block_hash: hash });
  const f = fixture();
  await f.run();
  expect(f.scan).toHaveBeenCalledWith(99, 100);
});
it('does not advance after a partially saved scan fails', async () => {
  const f = fixture();
  f.scan.mockRejectedValue(new Error('page two failed'));
  await expect(f.run()).rejects.toThrow('page two');
  expect(sqlExecutor.execute).not.toHaveBeenCalled();
});
it('does not advance after a block changes while the scan is running', async () => {
  const f = fixture();
  f.provider.getBlock
    .mockResolvedValueOnce({ number: 100, hash })
    .mockResolvedValueOnce({ number: 100, hash: 'other' });
  await expect(f.run()).rejects.toThrow('changed');
  expect(sqlExecutor.execute).not.toHaveBeenCalled();
});
it('does not regress a newer checkpoint or rescan it', async () => {
  jest
    .mocked(sqlExecutor.oneOrNull)
    .mockResolvedValue({ block: 101, block_hash: hash });
  const f = fixture();
  await f.run();
  expect(f.scan).not.toHaveBeenCalled();
  expect(sqlExecutor.execute).not.toHaveBeenCalled();
});
