import { JsonRpcProvider } from 'ethers';
import { sqlExecutor } from '@/sql-executor';
import { readScanCheckpoint } from '@/transactions/transaction-scan-checkpoint';
import { verifyIndexedSupply } from './drop-forge.supply';
import { testLaunchData } from './drop-forge.test-fixtures';
import { SupplyEvidenceError } from './drop-forge.types';

jest.mock('@/transactions/transaction-scan-checkpoint', () => ({
  readScanCheckpoint: jest.fn()
}));
jest.mock('@/sql-executor', () => ({
  ...jest.requireActual<typeof import('@/sql-executor')>('@/sql-executor'),
  sqlExecutor: { oneOrNull: jest.fn() }
}));

const hash = '0x' + 'a'.repeat(64);
function fixture() {
  const data = testLaunchData();
  data.edition_size = 305;
  const block = { hash, number: 100, timestamp: data.phases.at(-1)!.end + 60 };
  const provider = {
    getBlock: jest.fn(async (tag: string | number) =>
      tag === 'latest' ? { ...block, number: 120, timestamp: 8000 } : block
    )
  };
  const read = jest.fn(async () => ({
    total: 287,
    edition: 305,
    token: 1,
    end: data.phases.at(-1)!.end
  }));
  const run = (minimumBlock = 0) =>
    verifyIndexedSupply(
      data,
      provider as unknown as JsonRpcProvider,
      read,
      minimumBlock
    );
  return { data, provider, block, read, run };
}
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(8000000);
  jest
    .mocked(readScanCheckpoint)
    .mockResolvedValue({ block: 100, block_hash: hash });
  jest
    .mocked(sqlExecutor.oneOrNull)
    .mockResolvedValue({ total: '287', paid: '30' });
});
afterEach(() => jest.restoreAllMocks());

it('requires matching RPC and cumulative DB totals at a canonical finalized post-mint block', async () => {
  const f = fixture();
  await expect(f.run()).resolves.toMatchObject({
    status: 'VERIFIED',
    rpc_total: 287,
    db_total: 287,
    block_number: 100,
    block_hash: hash
  });
  expect(f.read).toHaveBeenCalledWith(hash);
  expect(sqlExecutor.oneOrNull).toHaveBeenCalledWith(
    expect.stringContaining('block <= :block'),
    expect.objectContaining({ block: 100 }),
    expect.objectContaining({ forcePool: 'WRITE' })
  );
});
it.each([280, 305])(
  'defers a wrong RPC total %i instead of approving an airdrop or false completion',
  async (total) => {
    const f = fixture();
    f.read.mockResolvedValue({ total, edition: 305, token: 1, end: 7000 });
    await expect(f.run()).rejects.toMatchObject({
      evidence: { status: 'WAITING', rpc_total: total, db_total: 287 }
    });
  }
);
it.each([null, { block: 99, block_hash: hash }])(
  'does not infer complete indexing from matching counts alone (%j)',
  async (checkpoint) => {
    jest.mocked(readScanCheckpoint).mockResolvedValue(checkpoint);
    await expect(fixture().run()).rejects.toThrow('indexing has not completed');
  }
);
it('uses a recent covered finalized block without requiring the indexer to catch a moving tip', async () => {
  const f = fixture();
  f.provider.getBlock.mockImplementation(async (tag) =>
    tag === 'latest'
      ? { ...f.block, number: 120, timestamp: 8000 }
      : tag === 'finalized'
        ? { ...f.block, number: 102, timestamp: f.block.timestamp + 24 }
        : f.block
  );
  await expect(f.run()).resolves.toMatchObject({
    block_number: 100,
    indexed_through: 100
  });
  f.provider.getBlock.mockImplementation(async (tag) =>
    tag === 'latest'
      ? { ...f.block, number: 150, timestamp: 8000 }
      : tag === 'finalized'
        ? { ...f.block, number: 140, timestamp: f.block.timestamp + 301 }
        : f.block
  );
  await expect(f.run()).rejects.toThrow('five minutes');
});
it('defers until the finalized block includes a confirmed transaction being reconciled', async () => {
  await expect(fixture().run(101)).rejects.toThrow('finalized post-mint');
});
it('rejects stale RPC heads, a pre-close block and a reorged indexing checkpoint', async () => {
  const f = fixture();
  f.provider.getBlock.mockResolvedValueOnce({ ...f.block, timestamp: 100 });
  await expect(f.run()).rejects.toThrow('stale');
  f.block.timestamp = 6999;
  await expect(f.run()).rejects.toThrow('post-mint');
  f.block.timestamp = 7100;
  jest
    .mocked(readScanCheckpoint)
    .mockResolvedValue({ block: 100, block_hash: 'wrong' });
  await expect(f.run()).rejects.toThrow('canonical');
});
it('does not expose endpoint credentials when an RPC call fails', async () => {
  const f = fixture();
  f.provider.getBlock.mockRejectedValueOnce(
    new Error('https://example.invalid/private-key')
  );
  await expect(f.run()).rejects.toThrow(SupplyEvidenceError);
  f.provider.getBlock.mockRejectedValueOnce(new Error('private-key'));
  await expect(f.run()).rejects.not.toThrow('private-key');
});
