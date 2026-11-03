import { MEMES_CONTRACT } from '@/constants';
import { NFTHistory } from '@/entities/INFTHistory';
import { parseHistoryRepairRequest, runHistoryRepair } from './history-repair';
import { nftHistoryDb } from './history.db';
import { nftHistoryReplayDb } from './replay.db';
import { decodeHistorySource } from './source-operations';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('./replay-manifest', () => ({
  ...jest.requireActual('./replay-manifest'),
  verifyReplayRange: async () => ({ cutoffHash: 'finalized' })
}));
jest.mock('./metadata', () => ({
  describeHistoryEdit: async (from: string, to: string) =>
    from === to ? null : { event: 'Edit', changes: [{ key: 'uri', from, to }] }
}));
jest.mock('./source-operations');
jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: () => ({
    getTransaction: async () => ({ blockNumber: 1, index: 0 }),
    getTransactionReceipt: async () => ({ status: 1, logs: [] })
  })
}));

const hash = (n: number) => '0x' + String(n).repeat(64);
const request = {
  mode: 'nft-history-repair',
  action: 'dry-run',
  contract: MEMES_CONTRACT,
  tokenId: 213,
  cutoffBlock: 10,
  mintTransaction: hash(2),
  editTransactions: [hash(1), hash(3)]
};
const budget = () => 900000;
const canonicalMint: NFTHistory = {
  contract: MEMES_CONTRACT,
  nft_id: 213,
  uri: 'gif',
  block: 2,
  transaction_hash: hash(2),
  transaction_date: new Date(2000),
  created_at: new Date(),
  description: { event: 'Mint', changes: [] }
};
const legacy = [
  { ...canonicalMint, uri: 'jpeg' },
  {
    ...canonicalMint,
    block: 3,
    transaction_hash: hash(3),
    description: { event: 'Edit', changes: [] }
  }
];

beforeEach(() => {
  jest
    .spyOn(nftHistoryDb, 'snapshot')
    .mockResolvedValue({ legacy, events: [] });
  jest.mocked(decodeHistorySource).mockImplementation(async ({ hash: tx }) =>
    tx === hash(2)
      ? [{ kind: 'mint', row: canonicalMint }]
      : [
          {
            kind: 'edit',
            previousUri: tx === hash(1) ? 'jpeg' : 'gif',
            beforeFirstMint: tx === hash(1),
            event: {
              contract: MEMES_CONTRACT,
              nft_id: 213,
              uri: 'gif',
              event_id: tx,
              transaction_hash: tx,
              block: tx === hash(1) ? 1 : 3,
              block_hash: 'block',
              extension: 'claim',
              claim_id: '456',
              transaction_index: 0,
              log_index: 0,
              transaction_date: new Date(1000)
            }
          }
        ]
  );
});

afterEach(() => jest.restoreAllMocks());

it('keeps the pre-Mint Edit and reconciles the colliding settings-only legacy Edit', async () => {
  const result = await runHistoryRepair(
    parseHistoryRepairRequest(request)!,
    budget
  );
  if (!('manifest' in result)) throw new Error('Expected dry-run');
  expect(
    result.manifest.plan.inserts.map((row) => [
      row.transaction_hash,
      row.description?.event ?? null
    ])
  ).toEqual([
    [hash(1), 'Edit'],
    [hash(3), null]
  ]);
  expect(result.manifest.plan.replaceMint).toMatchObject({
    oldUri: 'jpeg',
    collisionUri: 'gif',
    row: { uri: 'gif', transaction_hash: hash(2) }
  });
  expect(result.approvalDigest).toHaveLength(64);
});

it('rejects a Mint repair without the colliding source', async () => {
  await expect(
    runHistoryRepair(
      parseHistoryRepairRequest({ ...request, editTransactions: [hash(1)] })!,
      budget
    )
  ).rejects.toThrow('collision requires');
});

it('rejects an approved plan after history changes and leaves the job and rows untouched', async () => {
  const dry = await runHistoryRepair(
    parseHistoryRepairRequest(request)!,
    budget
  );
  const flag = process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
  process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = 'true';
  const create = jest.spyOn(nftHistoryReplayDb, 'create');
  const write = jest.spyOn(nftHistoryDb, 'apply');
  jest.spyOn(nftHistoryReplayDb, 'find').mockResolvedValue(null);
  jest.mocked(nftHistoryDb.snapshot).mockResolvedValue({
    legacy: [{ ...legacy[0], uri: 'other' }, legacy[1]],
    events: []
  });
  try {
    await expect(
      runHistoryRepair(
        parseHistoryRepairRequest({
          ...request,
          action: 'apply',
          jobId: '44377abc-20ee-435a-83f8-02c7d25c7c44',
          approvalDigest: dry.approvalDigest
        })!,
        budget
      )
    ).rejects.toThrow('changed');
    expect(create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  } finally {
    if (flag === undefined) delete process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
    else process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = flag;
  }
});
