import { MEMES_CONTRACT } from '@/constants';
import { NFTHistory } from '@/entities/INFTHistory';
import { parseHistoryRepairRequest, runHistoryRepair } from './history-repair';
import { nftHistoryDb } from './history.db';
import { nftHistoryReplayDb } from './replay.db';
import {
  decodeDeferredInitialization,
  decodeHistorySource
} from './source-operations';
import { canonicalJson } from './canonical-json';

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
  initializationTransaction: hash(2),
  editTransactions: [hash(1), hash(3)]
};
const budget = () => 900000;
const canonicalInitialization: NFTHistory = {
  contract: MEMES_CONTRACT,
  nft_id: 213,
  uri: 'jpeg',
  block: 1,
  transaction_hash: hash(2),
  transaction_date: new Date(2000),
  created_at: new Date(),
  description: { event: 'Initialized', changes: [] }
};
const legacy = [
  {
    ...canonicalInitialization,
    block: 2,
    transaction_hash: hash(4),
    description: { event: 'Mint', changes: [] }
  },
  {
    ...canonicalInitialization,
    block: 3,
    uri: 'gif',
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
      ? [{ kind: 'mint', row: canonicalInitialization }]
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

it('restores the original initialization and attributes the Edit to its real source', async () => {
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
  expect(result.manifest.plan.replaceBaseline).toMatchObject({
    oldUri: 'jpeg',
    row: {
      uri: 'jpeg',
      transaction_hash: hash(2),
      description: { event: 'Initialized' }
    }
  });
  expect(result.approvalDigest).toHaveLength(64);
});

it('rejects an origin whose URI differs from the audited baseline', async () => {
  jest.mocked(nftHistoryDb.snapshot).mockResolvedValue({
    legacy: [{ ...legacy[0], uri: 'wrong' }, legacy[1]],
    events: []
  });
  await expect(
    runHistoryRepair(
      parseHistoryRepairRequest({ ...request, editTransactions: [hash(1)] })!,
      budget
    )
  ).rejects.toThrow('verified original URI');
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
    legacy: [{ ...legacy[0], block: 9 }, legacy[1]],
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

it('resumes a saved repair and returns the same completed receipt on retry', async () => {
  jest
    .mocked(decodeDeferredInitialization)
    .mockResolvedValue(canonicalInitialization);
  const deferred = { ...request, assignmentTransaction: hash(5) };
  const flag = process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
  process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = 'true';
  const find = jest.spyOn(nftHistoryReplayDb, 'find').mockResolvedValue(null);
  const create = jest
    .spyOn(nftHistoryReplayDb, 'create')
    .mockImplementation(async (job_id, digest, scope, manifest) => {
      const job = {
        job_id,
        digest,
        request_json: canonicalJson(scope),
        manifest_json: canonicalJson(manifest),
        next_index: 0,
        created_at: new Date()
      };
      find.mockResolvedValue(job);
      return job;
    });
  const write = jest
    .spyOn(nftHistoryDb, 'apply')
    .mockRejectedValueOnce(new Error('interrupted'));
  try {
    const dry = await runHistoryRepair(
      parseHistoryRepairRequest(deferred)!,
      budget
    );
    const apply = parseHistoryRepairRequest({
      ...deferred,
      editTransactions: [...deferred.editTransactions].reverse(),
      action: 'apply',
      jobId: '44377abc-20ee-435a-83f8-02c7d25c7c44',
      approvalDigest: dry.approvalDigest
    })!;
    await expect(runHistoryRepair(apply, budget)).rejects.toThrow(
      'interrupted'
    );
    const saved = await nftHistoryReplayDb.find(
      '44377abc-20ee-435a-83f8-02c7d25c7c44'
    );
    write.mockImplementationOnce(async () => {
      saved!.next_index = 1;
    });
    const receipt = await runHistoryRepair(apply, budget);
    expect(receipt).toMatchObject({ complete: true });
    expect(await runHistoryRepair(apply, budget)).toEqual(receipt);
    expect(create).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
  } finally {
    if (flag === undefined) delete process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
    else process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = flag;
  }
});
