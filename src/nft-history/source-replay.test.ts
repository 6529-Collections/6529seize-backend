import { MEMES_CONTRACT } from '@/constants';
import { NFTHistoryReplayJobEntity } from '@/entities/INFTHistoryReplayJob';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { canonicalJson } from './canonical-json';
import { discoverHistoryTransactions } from './history-transactions';
import { decodeHistorySource } from './source-operations';
import { VirtualSourceReader } from './source-plan';
import { historySourceDb } from './source.db';
import { nftHistoryReplayDb } from './replay.db';
import {
  parseSourceReplayRequest,
  runSourceReplay,
  ingestHistorySources,
  SourceReplayRequest
} from './source-replay';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
jest.mock('./history-transactions', () => ({
  discoverHistoryTransactions: jest.fn()
}));
jest.mock('./source-operations', () => ({ decodeHistorySource: jest.fn() }));
jest.mock('./source.db', () => ({
  historySourceDb: { history: jest.fn(), claims: jest.fn(), apply: jest.fn() }
}));
jest.mock('./replay.db', () => ({
  nftHistoryReplayDb: { find: jest.fn(), create: jest.fn(), advance: jest.fn() }
}));
const request: SourceReplayRequest = {
  mode: 'nft-history-source-replay',
  action: 'dry-run',
  fromBlock: 1,
  toBlock: 2,
  cutoffBlock: 100
};
const jobId = '56900000-0000-4000-8000-000000000001';
let view: VirtualSourceReader;
let job: NFTHistoryReplayJobEntity | null;
const priorFlag = process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
  job = null;
  view = new VirtualSourceReader({
    history: async () => ({ legacy: [], events: [] }),
    claims: async () => []
  });
  jest
    .mocked(historySourceDb.history)
    .mockImplementation((contract, tokenId) => view.history(contract, tokenId));
  jest
    .mocked(historySourceDb.claims)
    .mockImplementation((contract, claimId) => view.claims(contract, claimId));
  jest.mocked(historySourceDb.apply).mockImplementation(async (plan, after) => {
    await view.apply(plan);
    await after?.({} as never);
  });
  jest.mocked(getEthereumRpcClient).mockReturnValue({
    getBlock: jest.fn(async (tag: number | string) => ({
      number: tag === 'finalized' ? 100 : tag,
      hash: `hash-${tag}`
    }))
  } as unknown as ReturnType<typeof getEthereumRpcClient>);
  jest.mocked(discoverHistoryTransactions).mockResolvedValue(
    [1, 2].map((block) => ({
      hash: `tx-${block}`,
      block,
      transactionIndex: 1,
      logs: []
    }))
  );
  jest.mocked(decodeHistorySource).mockImplementation(async (source) =>
    source.block === 1
      ? [
          {
            kind: 'claim',
            claim: {
              contract: MEMES_CONTRACT,
              tokenId: 569,
              claimId: '12345',
              location: 'A'
            }
          }
        ]
      : [
          {
            kind: 'mint',
            row: {
              contract: MEMES_CONTRACT,
              nft_id: 569,
              uri: 'A',
              block: 2,
              transaction_hash: 'tx-2',
              transaction_date: new Date(2000),
              created_at: new Date(),
              description: { event: 'Mint', changes: [] }
            }
          }
        ]
  );
  jest.mocked(nftHistoryReplayDb.find).mockImplementation(async () => job);
  jest
    .mocked(nftHistoryReplayDb.create)
    .mockImplementation(async (id, digest, range, manifest) => {
      job = {
        job_id: id,
        digest,
        request_json: canonicalJson(range),
        manifest_json: canonicalJson(manifest),
        next_index: 0,
        created_at: new Date()
      };
      return job;
    });
  jest
    .mocked(nftHistoryReplayDb.advance)
    .mockImplementation(async (_manager, _id, index) => {
      if (!job || job.next_index !== index) throw new Error('cursor conflict');
      job.next_index++;
    });
});
afterEach(() => {
  if (priorFlag === undefined)
    delete process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
  else process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = priorFlag;
});
async function audit() {
  const result = await runSourceReplay(request, () => 900000);
  if (!('manifest' in result)) throw new Error('Expected audit');
  return result;
}
function apply(digest: string): SourceReplayRequest {
  return { ...request, action: 'apply', jobId, approvalDigest: digest };
}

it('produces a read-only claim/Mint recovery proposal, with a stable digest and no normal checkpoint writes', async () => {
  const report = await audit();
  expect(report.applicable).toBe(true);
  expect(report.manifest.entries).toHaveLength(2);
  expect(await view.claims(MEMES_CONTRACT, '12345')).toEqual([]);
  expect((await view.history(MEMES_CONTRACT, 569)).legacy).toEqual([]);
  expect(historySourceDb.apply).not.toHaveBeenCalled();
  expect(nftHistoryReplayDb.create).not.toHaveBeenCalled();
  expect((await audit()).approvalDigest).toBe(report.approvalDigest);
});

it('requires separate apply enablement even for a matching approved plan', async () => {
  const report = await audit();
  await expect(
    runSourceReplay(apply(report.approvalDigest), () => 900000)
  ).rejects.toThrow('disabled');
  expect(nftHistoryReplayDb.find).not.toHaveBeenCalled();
});

it('applies mappings and Mints with resumable transaction checkpoints and completed-job idempotency', async () => {
  const report = await audit();
  process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = 'true';
  const result = await runSourceReplay(
    apply(report.approvalDigest),
    () => 900000
  );
  expect(result).toEqual(
    expect.objectContaining({ complete: true, nextIndex: 2 })
  );
  expect((await view.claims(MEMES_CONTRACT, '12345'))[0].nft_id).toBe(569);
  expect((await view.history(MEMES_CONTRACT, 569)).legacy).toHaveLength(1);
  await expect(
    runSourceReplay(apply(report.approvalDigest), () => 900000)
  ).resolves.toEqual(result);
  expect(historySourceDb.apply).toHaveBeenCalledTimes(2);
});

it('rejects stale digests, corrupt or differently scoped jobs and scheduled replay requests', async () => {
  process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = 'true';
  await expect(
    runSourceReplay(apply('a'.repeat(64)), () => 900000)
  ).rejects.toThrow('changed since approval');
  expect(nftHistoryReplayDb.create).not.toHaveBeenCalled();
  const report = await audit();
  await runSourceReplay(apply(report.approvalDigest), () => 900000);
  job!.manifest_json = '{}';
  await expect(
    runSourceReplay(apply(report.approvalDigest), () => 900000)
  ).rejects.toThrow('Invalid or differently scoped');
  expect(() =>
    parseSourceReplayRequest({ ...request, source: 'aws.events' })
  ).toThrow();
  expect(() =>
    parseSourceReplayRequest({ ...request, toBlock: 5000 })
  ).toThrow();
});

it('reports unsupported evidence and prevents any apply when the audit has failures', async () => {
  jest
    .mocked(decodeHistorySource)
    .mockRejectedValue(new Error('unverified extension'));
  const report = await audit();
  expect(report.applicable).toBe(false);
  expect(report.manifest.failures).toHaveLength(2);
  process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = 'true';
  await expect(
    runSourceReplay(apply(report.approvalDigest), () => 900000)
  ).rejects.toThrow('blocked');
  expect(historySourceDb.apply).not.toHaveBeenCalled();
});

it('resumes a partial source replay from the saved immutable cursor', async () => {
  const report = await audit();
  process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = 'true';
  const partial = await runSourceReplay(apply(report.approvalDigest), () =>
    job?.next_index === 1 ? 0 : 900000
  );
  expect(partial).toEqual(
    expect.objectContaining({
      complete: false,
      nextIndex: 1,
      nextFromBlock: null
    })
  );
  expect(job!.next_index).toBe(1);
  expect((await view.history(MEMES_CONTRACT, 569)).legacy).toHaveLength(0);
  await expect(
    runSourceReplay(apply(report.approvalDigest), () => 900000)
  ).resolves.toEqual(expect.objectContaining({ complete: true, nextIndex: 2 }));
  expect((await view.history(MEMES_CONTRACT, 569)).legacy).toHaveLength(1);
});

it('checkpoints only complete blocks and replays all sources in an interrupted block', async () => {
  const sources = [
    { hash: 'tx-1', block: 1, transactionIndex: 1, logs: [] },
    { hash: 'tx-2', block: 2, transactionIndex: 1, logs: [] },
    { hash: 'tx-2-later', block: 2, transactionIndex: 2, logs: [] },
    { hash: 'tx-3', block: 3, transactionIndex: 1, logs: [] }
  ];
  jest
    .mocked(discoverHistoryTransactions)
    .mockImplementation((from, to) =>
      Promise.resolve(
        sources.filter((source) => source.block >= from && source.block <= to)
      )
    );
  let remaining = 900000;
  jest.mocked(historySourceDb.apply).mockImplementation(async (plan) => {
    await view.apply(plan);
    if (plan.writes.length) remaining = 0;
  });
  const checkpoint = jest.fn(() => Promise.resolve());
  await expect(
    ingestHistorySources(1, 3, () => remaining, checkpoint)
  ).rejects.toThrow('History time budget exhausted');
  expect(checkpoint.mock.calls).toEqual([[1]]);
  expect((await view.history(MEMES_CONTRACT, 569)).legacy).toHaveLength(1);
  expect(
    jest.mocked(decodeHistorySource).mock.calls.map(([source]) => source.hash)
  ).toEqual(['tx-1', 'tx-2']);

  remaining = 900000;
  await ingestHistorySources(2, 3, () => remaining, checkpoint);
  expect(checkpoint.mock.calls).toEqual([[1], [2], [3]]);
  expect(
    jest.mocked(decodeHistorySource).mock.calls.map(([source]) => source.hash)
  ).toEqual(['tx-1', 'tx-2', 'tx-2', 'tx-2-later', 'tx-3']);
  expect((await view.history(MEMES_CONTRACT, 569)).legacy).toHaveLength(1);
});

it('discovers small chunks and checkpoints empty blocks without skipping undiscovered ranges', async () => {
  jest.mocked(discoverHistoryTransactions).mockResolvedValue([]);
  const checkpoint = jest.fn(() => Promise.resolve());
  await ingestHistorySources(1, 45, () => 900000, checkpoint);
  expect(
    jest
      .mocked(discoverHistoryTransactions)
      .mock.calls.map(([from, to]) => [from, to])
  ).toEqual([
    [1, 20],
    [21, 40],
    [41, 45]
  ]);
  expect(checkpoint.mock.calls).toEqual([[20], [40], [45]]);
  expect(historySourceDb.apply).not.toHaveBeenCalled();
});

it('retains completed discovery chunks when a later chunk fails', async () => {
  jest
    .mocked(discoverHistoryTransactions)
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('discovery time budget exhausted'));
  const checkpoint = jest.fn(() => Promise.resolve());
  await expect(
    ingestHistorySources(1, 45, () => 900000, checkpoint)
  ).rejects.toThrow('discovery time budget exhausted');
  expect(checkpoint.mock.calls).toEqual([[20]]);
});
