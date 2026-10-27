import { MEMES_CONTRACT } from '@/constants';
import { NFTHistory } from '@/entities/INFTHistory';
import { ClaimEvent } from './claim-events';
import { HistorySnapshot } from './history.db';
import { prepareHistoryWrite } from './processor';
import { describeHistoryEdit } from './metadata';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: () => ({
    getTransaction: async () => ({ blockNumber: 1, index: 0 })
  })
}));
jest.mock('./metadata', () => ({
  describeHistoryEdit: jest.fn(async (from: string, to: string) =>
    from === to ? null : { event: 'Edit', changes: [{ key: 'uri', from, to }] }
  )
}));

const mint: NFTHistory = {
  contract: MEMES_CONTRACT,
  nft_id: 550,
  uri: 'A',
  block: 1,
  transaction_hash: 'mint',
  transaction_date: new Date(1000),
  created_at: new Date(1000),
  description: { event: 'Mint', changes: [] }
};
function candidate(uri = 'B', block = 2, index = 1): ClaimEvent {
  return {
    event_id: `event-${block}-${index}`,
    contract: MEMES_CONTRACT,
    nft_id: 550,
    uri,
    block,
    transaction_hash: `tx-${block}-${index}`,
    block_hash: `block-${block}`,
    claim_id: '12345',
    extension: 'extension',
    transaction_date: new Date(block * 1000),
    transaction_index: index,
    log_index: index
  };
}
const snapshot = (): HistorySnapshot => ({ legacy: [mint], events: [] });

it('preserves A -> B -> A without changing Mint and is idempotent by event', async () => {
  const state = snapshot();
  const first = await prepareHistoryWrite(candidate(), state);
  state.events.push(...first.inserts);
  const second = await prepareHistoryWrite(candidate('A', 3), state);
  state.events.push(...second.inserts);
  expect(state.events.map((row) => row.uri)).toEqual(['B', 'A']);
  expect(state.legacy[0].description.event).toBe('Mint');
  expect((await prepareHistoryWrite(candidate('A', 3), state)).inserts).toEqual(
    []
  );
});

it('audits unchanged-URI settings updates without a Timeline Edit', async () => {
  const plan = await prepareHistoryWrite(candidate('A'), snapshot());
  expect(plan.inserts).toHaveLength(1);
  expect(plan.inserts[0].description).toBeNull();
});

it('uses transaction/log order for multiple edits in one block', async () => {
  const state = snapshot();
  state.events.push(
    ...(await prepareHistoryWrite(candidate('B', 2, 10), state)).inserts
  );
  const plan = await prepareHistoryWrite(candidate('C', 2, 20), state);
  expect(plan.inserts[0].description?.changes).toEqual([
    { key: 'uri', from: 'B', to: 'C' }
  ]);
});

it('reconciles the next recorded edit when inserting an older missing edit', async () => {
  const state = snapshot();
  state.events.push(
    ...(await prepareHistoryWrite(candidate('C', 3), state)).inserts
  );
  const plan = await prepareHistoryWrite(candidate('B', 2), state);
  expect(plan.eventUpdates).toEqual([
    {
      event_id: 'event-3-1',
      description: {
        event: 'Edit',
        changes: [{ key: 'uri', from: 'B', to: 'C' }]
      }
    }
  ]);
});

it('supersedes a matching legacy transaction, not another occurrence of its URI', async () => {
  const state = snapshot();
  state.legacy.push({
    ...mint,
    block: 2,
    uri: 'B',
    transaction_hash: 'tx-2-1',
    description: { event: 'Edit', changes: [] }
  });
  const plan = await prepareHistoryWrite(candidate('B'), state);
  expect(plan.inserts[0].description?.changes).toEqual([
    { key: 'uri', from: 'A', to: 'B' }
  ]);
  expect(plan.legacyUpdates).toEqual([]);
});

it('rejects missing baselines and conflicting chain identity without writes', async () => {
  await expect(
    prepareHistoryWrite(candidate(), { legacy: [], events: [] })
  ).rejects.toThrow('Missing predecessor');
  const state = snapshot();
  state.events.push(...(await prepareHistoryWrite(candidate(), state)).inserts);
  await expect(
    prepareHistoryWrite({ ...candidate(), uri: 'evil' }, state)
  ).rejects.toThrow('differs from canonical');
});

it('propagates failed metadata fetches before producing a write plan', async () => {
  jest
    .mocked(describeHistoryEdit)
    .mockRejectedValueOnce(new Error('fetch failed'));
  await expect(prepareHistoryWrite(candidate(), snapshot())).rejects.toThrow(
    'fetch failed'
  );
});
