import { connect, disconnect, getDataSource } from '@/db';
import { fetchNftHistory } from '@/db-api';
import { NFTHistory, NFTHistoryClaim } from '@/entities/INFTHistory';
import { NFTHistoryEventEntity } from '@/entities/INFTHistoryEvent';
import { ClaimEvent } from './claim-events';
import { NftHistoryDb } from './history.db';
import { prepareHistoryWrite } from './processor';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: () => ({
    getTransaction: async () => ({ blockNumber: 1, index: 0 })
  })
}));

const contract = '0x0000000000000000000000000000000000055000';
const nft_id = 550000;
const db = new NftHistoryDb();
const describe = async (from: string, to: string) =>
  from === to
    ? null
    : { event: 'Edit' as const, changes: [{ key: 'uri', from, to }] };
const candidate = (uri: string, block: number): ClaimEvent => ({
  contract,
  nft_id,
  uri,
  block,
  transaction_index: 1,
  log_index: 1,
  event_id: `db-test-${block}`,
  transaction_hash: `edit-${block}`,
  block_hash: `block-${block}`,
  extension: contract,
  claim_id: '12345',
  transaction_date: new Date(block * 1000)
});

beforeEach(async () => {
  await connect([NFTHistory, NFTHistoryClaim, NFTHistoryEventEntity]);
  await getDataSource()
    .getRepository(NFTHistoryEventEntity)
    .delete({ contract });
  await getDataSource().getRepository(NFTHistory).delete({ contract });
  await getDataSource()
    .getRepository(NFTHistory)
    .save({
      contract,
      nft_id,
      uri: 'A',
      block: 1,
      transaction_hash: 'mint',
      transaction_date: new Date(1000),
      description: { event: 'Mint', changes: [] }
    });
});
afterEach(async () => {
  await getDataSource()
    .getRepository(NFTHistoryEventEntity)
    .delete({ contract });
  await getDataSource().getRepository(NFTHistory).delete({ contract });
  await disconnect();
});

it('keeps Mint and repeated URIs in the real history API query', async () => {
  for (const event of [candidate('B', 2), candidate('A', 3)]) {
    await db.apply(
      await prepareHistoryWrite(
        event,
        await db.snapshot(contract, nft_id),
        describe
      )
    );
  }
  expect(
    (
      await prepareHistoryWrite(
        candidate('A', 3),
        await db.snapshot(contract, nft_id),
        describe
      )
    ).inserts
  ).toEqual([]);
  const result = await fetchNftHistory(10, 1, contract, nft_id);
  expect(Number(result.count)).toBe(3);
  expect(result.data.map((row) => row.transaction_hash)).toEqual([
    'edit-3',
    'edit-2',
    'mint'
  ]);
  expect(
    (
      await getDataSource()
        .getRepository(NFTHistory)
        .findOneByOrFail({ contract, nft_id })
    ).description.event
  ).toBe('Mint');
});

it('rolls back history and the attached checkpoint together', async () => {
  const plan = await prepareHistoryWrite(
    candidate('B', 2),
    await db.snapshot(contract, nft_id),
    describe
  );
  await expect(
    db.apply(plan, async () => {
      throw new Error('checkpoint failed');
    })
  ).rejects.toThrow('checkpoint failed');
  expect(
    await getDataSource()
      .getRepository(NFTHistoryEventEntity)
      .countBy({ contract })
  ).toBe(0);
});

it('rejects stale plans after another writer changes history', async () => {
  const plan = await prepareHistoryWrite(
    candidate('B', 2),
    await db.snapshot(contract, nft_id),
    describe
  );
  await db.apply(
    await prepareHistoryWrite(
      candidate('C', 3),
      await db.snapshot(contract, nft_id),
      describe
    )
  );
  await expect(db.apply(plan)).rejects.toThrow('History changed');
  expect(
    await getDataSource()
      .getRepository(NFTHistoryEventEntity)
      .countBy({ contract })
  ).toBe(1);
});

it('hides settings-only events and suppresses only matching legacy transactions', async () => {
  await db.apply(
    await prepareHistoryWrite(
      candidate('A', 2),
      await db.snapshot(contract, nft_id),
      describe
    )
  );
  expect(Number((await fetchNftHistory(10, 1, contract, nft_id)).count)).toBe(
    1
  );
  await getDataSource()
    .getRepository(NFTHistory)
    .save({
      contract,
      nft_id,
      uri: 'B',
      block: 3,
      transaction_hash: 'edit-3',
      transaction_date: new Date(3000),
      description: { event: 'Edit', changes: [] }
    });
  await db.apply(
    await prepareHistoryWrite(
      candidate('B', 3),
      await db.snapshot(contract, nft_id),
      describe
    )
  );
  expect(Number((await fetchNftHistory(10, 1, contract, nft_id)).count)).toBe(
    2
  );
});

it('round-trips raw inserts and native ORM successor JSON updates consistently', async () => {
  const later = candidate('C', 3);
  await db.apply(
    await prepareHistoryWrite(
      later,
      await db.snapshot(contract, nft_id),
      describe
    )
  );
  const rawInserted = (await db.snapshot(contract, nft_id)).events[0];
  expect(rawInserted.description).toEqual({
    event: 'Edit',
    changes: [{ key: 'uri', from: 'A', to: 'C' }]
  });
  await db.apply(
    await prepareHistoryWrite(
      candidate('B', 2),
      await db.snapshot(contract, nft_id),
      describe
    )
  );
  const updated = (await db.snapshot(contract, nft_id)).events.find(
    (row) => row.event_id === later.event_id
  )!;
  expect(updated.description).toEqual({
    event: 'Edit',
    changes: [{ key: 'uri', from: 'B', to: 'C' }]
  });
  expect(
    (
      await prepareHistoryWrite(
        later,
        await db.snapshot(contract, nft_id),
        describe
      )
    ).inserts
  ).toEqual([]);
});
