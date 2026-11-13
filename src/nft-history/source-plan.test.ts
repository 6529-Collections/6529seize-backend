import { MEMES_CONTRACT } from '@/constants';
import { NFTHistory } from '@/entities/INFTHistory';
import { ClaimEvent } from './claim-events';
import {
  prepareSourcePlan,
  VirtualSourceReader,
  sourcePlanReceipt
} from './source-plan';
import { HistorySourceOperation } from './source-operations';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: () => ({
    getTransaction: async () => ({ blockNumber: 2, index: 1 })
  })
}));
jest.mock('./metadata', () => ({
  describeHistoryEdit: async (from: string, to: string) =>
    from === to ? null : { event: 'Edit', changes: [{ key: 'uri', from, to }] }
}));
const mint: NFTHistory = {
  contract: MEMES_CONTRACT,
  nft_id: 569,
  uri: 'A',
  block: 2,
  transaction_hash: 'mint',
  transaction_date: new Date(2000),
  created_at: new Date(),
  description: { event: 'Mint', changes: [] }
};
const mapping = {
  contract: MEMES_CONTRACT,
  claimId: '12345',
  tokenId: 569,
  location: 'A'
};
function event(): ClaimEvent {
  return {
    contract: MEMES_CONTRACT,
    nft_id: 569,
    uri: 'B',
    block: 3,
    transaction_hash: 'update',
    transaction_index: 1,
    log_index: 2,
    event_id: 'event',
    block_hash: 'block',
    extension: 'extension',
    claim_id: '12345',
    transaction_date: new Date(3000)
  };
}
function reader() {
  return new VirtualSourceReader({
    history: async () => ({ legacy: [], events: [] }),
    claims: async () => []
  });
}

it('audits initialization -> first Mint -> metadata edit in order and replays all three idempotently', async () => {
  const view = reader();
  const operations: HistorySourceOperation[][] = [
    [{ kind: 'claim', claim: mapping }],
    [
      { kind: 'claim', claim: mapping },
      { kind: 'mint', row: mint }
    ],
    [{ kind: 'edit', event: event(), beforeFirstMint: false }]
  ];
  for (const input of operations)
    await view.apply(await prepareSourcePlan(input, view));
  expect((await view.claims(MEMES_CONTRACT, '12345'))[0].nft_id).toBe(569);
  const result = await view.history(MEMES_CONTRACT, 569);
  expect(result.legacy).toHaveLength(1);
  expect(result.events).toHaveLength(1);
  expect(result.events[0].description?.changes).toEqual([
    { key: 'uri', from: 'A', to: 'B' }
  ]);
  for (const input of operations)
    expect(await prepareSourcePlan(input, view)).toEqual({
      claims: [],
      writes: []
    });
});

it('records the initialized URI change before Mint and keeps the later Mint', async () => {
  const view = reader();
  const update = { ...event(), block: 1 };
  const plan = await prepareSourcePlan(
    [{ kind: 'edit', event: update, beforeFirstMint: true, previousUri: 'A' }],
    view
  );
  expect(plan.writes[0]).toEqual(
    expect.objectContaining({
      kind: 'edit',
      plan: expect.objectContaining({
        inserts: [
          expect.objectContaining({
            description: {
              event: 'Edit',
              changes: [{ key: 'uri', from: 'A', to: 'B' }]
            }
          })
        ]
      })
    })
  );
  await view.apply(plan);
  await view.apply(
    await prepareSourcePlan(
      [{ kind: 'mint', row: { ...mint, uri: 'B' } }],
      view
    )
  );
  expect(
    (await view.history(MEMES_CONTRACT, 569)).legacy[0].description.event
  ).toBe('Mint');
});

it('rejects a missing positive Mint baseline and conflicting exact mapping keys', async () => {
  await expect(
    prepareSourcePlan(
      [{ kind: 'edit', event: event(), beforeFirstMint: false }],
      reader()
    )
  ).rejects.toThrow('Mint baseline missing');
  const view = new VirtualSourceReader({
    history: async () => ({ legacy: [], events: [] }),
    claims: async () => [
      {
        contract: MEMES_CONTRACT,
        claimIndex: 12345,
        nft_id: 570,
        location: 'A'
      }
    ]
  });
  await expect(
    prepareSourcePlan([{ kind: 'claim', claim: mapping }], view)
  ).rejects.toThrow('conflicts');
});

it('does not include nondeterministic creation timestamps in reviewed receipts', async () => {
  const a = await prepareSourcePlan([{ kind: 'mint', row: mint }], reader());
  const b = await prepareSourcePlan(
    [{ kind: 'mint', row: { ...mint, created_at: new Date(0) } }],
    reader()
  );
  expect(sourcePlanReceipt(a)).toEqual(sourcePlanReceipt(b));
});
