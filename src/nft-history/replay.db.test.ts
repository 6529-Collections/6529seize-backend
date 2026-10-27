import { connect, disconnect, getDataSource } from '@/db';
import { NFTHistory } from '@/entities/INFTHistory';
import { NFTHistoryEventEntity } from '@/entities/INFTHistoryEvent';
import { NFTHistoryReplayJobEntity } from '@/entities/INFTHistoryReplayJob';
import { NftHistoryDb } from './history.db';
import { NftHistoryReplayDb } from './replay.db';
import { prepareHistoryWrite } from './processor';
import { ClaimEvent } from './claim-events';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: () => ({
    getTransaction: async () => ({ blockNumber: 1, index: 0 })
  })
}));
const db = new NftHistoryDb();
const replay = new NftHistoryReplayDb();
const contract = '0x0000000000000000000000000000000000055001';
const jobId = '55000000-0000-4000-8000-000000000002';
const candidate = (block: number): ClaimEvent => ({
  contract,
  nft_id: 550001,
  event_id: `replay-db-${block}`,
  uri: `uri-${block}`,
  block,
  transaction_hash: `tx-${block}`,
  transaction_index: 1,
  log_index: 1,
  block_hash: `block-${block}`,
  extension: contract,
  claim_id: '12345',
  transaction_date: new Date(block * 1000)
});
const describe = async (from: string, to: string) => ({
  event: 'Edit' as const,
  changes: [{ key: 'uri', from, to }]
});

beforeEach(async () => {
  await connect([NFTHistory, NFTHistoryEventEntity, NFTHistoryReplayJobEntity]);
  await getDataSource()
    .getRepository(NFTHistoryReplayJobEntity)
    .delete({ job_id: jobId });
  await getDataSource()
    .getRepository(NFTHistoryEventEntity)
    .delete({ contract });
  await getDataSource().getRepository(NFTHistory).delete({ contract });
  await getDataSource()
    .getRepository(NFTHistory)
    .save({
      contract,
      nft_id: 550001,
      uri: 'mint',
      block: 1,
      transaction_hash: 'mint',
      transaction_date: new Date(1000),
      description: { event: 'Mint', changes: [] }
    });
  await replay.create(
    jobId,
    'a'.repeat(64),
    { fromBlock: 2, toBlock: 3, cutoffBlock: 100 },
    {
      version: 1,
      range: { fromBlock: 2, toBlock: 3, cutoffBlock: 100 },
      cutoffHash: 'cutoff',
      windowEndHash: 'end',
      entries: [],
      failures: []
    }
  );
});
afterEach(async () => {
  await getDataSource()
    .getRepository(NFTHistoryReplayJobEntity)
    .delete({ job_id: jobId });
  await getDataSource()
    .getRepository(NFTHistoryEventEntity)
    .delete({ contract });
  await getDataSource().getRepository(NFTHistory).delete({ contract });
  await disconnect();
});

it('commits event and cursor atomically and rolls both back on a cursor conflict', async () => {
  const first = await prepareHistoryWrite(
    candidate(2),
    await db.snapshot(contract, 550001),
    describe
  );
  await db.apply(first, (manager) => replay.advance(manager, jobId, 0));
  expect((await replay.find(jobId))!.next_index).toBe(1);
  const second = await prepareHistoryWrite(
    candidate(3),
    await db.snapshot(contract, 550001),
    describe
  );
  await expect(
    db.apply(second, (manager) => replay.advance(manager, jobId, 0))
  ).rejects.toThrow('cursor changed');
  expect((await replay.find(jobId))!.next_index).toBe(1);
  expect(
    await getDataSource()
      .getRepository(NFTHistoryEventEntity)
      .countBy({ contract })
  ).toBe(1);
});

it('never upserts or rewinds a previously approved job', async () => {
  await expect(
    replay.create(
      jobId,
      'b'.repeat(64),
      { fromBlock: 2, toBlock: 3, cutoffBlock: 100 },
      {} as never
    )
  ).rejects.toThrow();
  expect((await replay.find(jobId))!.digest).toBe('a'.repeat(64));
});
