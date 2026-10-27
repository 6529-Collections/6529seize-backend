import { MEMES_CONTRACT } from '@/constants';
import { NFTHistoryReplayJobEntity } from '@/entities/INFTHistoryReplayJob';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import {
  ClaimEvent,
  decodeClaimUpdate,
  discoverClaimUpdates
} from './claim-events';
import { HistorySnapshot, nftHistoryDb } from './history.db';
import { describeHistoryEdit } from './metadata';
import { canonicalJson } from './canonical-json';
import { applyVirtualPlan } from './replay-manifest';
import { nftHistoryReplayDb } from './replay.db';
import { ReplayRange, ReplayRequest } from './replay-request';
import { runHistoryReplay } from './replay';
import type { Log } from '@/ethereum-rpc/ethereum-rpc-types';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
jest.mock('./claim-events', () => ({
  ...jest.requireActual('./claim-events'),
  decodeClaimUpdate: jest.fn(),
  discoverClaimUpdates: jest.fn()
}));
jest.mock('./history.db', () => ({
  ...jest.requireActual('./history.db'),
  nftHistoryDb: {
    snapshot: jest.fn(),
    resolveClaim: jest.fn(),
    apply: jest.fn()
  }
}));
jest.mock('./metadata', () => ({ describeHistoryEdit: jest.fn() }));
jest.mock('./replay.db', () => ({
  nftHistoryReplayDb: { find: jest.fn(), create: jest.fn(), advance: jest.fn() }
}));

const range: ReplayRange = { fromBlock: 2, toBlock: 20, cutoffBlock: 100 };
const dryRun: ReplayRequest = {
  ...range,
  mode: 'nft-history-replay',
  action: 'dry-run'
};
const jobId = '55000000-0000-4000-8000-000000000001';
const originalFlag = process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
let state: HistorySnapshot;
let job: NFTHistoryReplayJobEntity | null;
function event(block: number, uri: string): ClaimEvent {
  return {
    event_id: `event-${block}`,
    contract: MEMES_CONTRACT,
    nft_id: 550,
    uri,
    block,
    transaction_index: 1,
    log_index: 1,
    transaction_hash: `tx-${block}`,
    block_hash: `hash-${block}`,
    extension: 'extension',
    claim_id: '12345',
    transaction_date: new Date(block * 1000)
  };
}
function applyRequest(digest: string): ReplayRequest {
  return {
    ...range,
    mode: 'nft-history-replay',
    action: 'apply',
    jobId,
    approvalDigest: digest
  };
}
async function dryReport() {
  const result = await runHistoryReplay(dryRun, () => 900000);
  if (!('manifest' in result)) throw new Error('Expected audit report');
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = 'true';
  state = {
    legacy: [
      {
        contract: MEMES_CONTRACT,
        nft_id: 550,
        uri: 'A',
        block: 1,
        transaction_hash: 'mint',
        transaction_date: new Date(1000),
        created_at: new Date(1000),
        description: { event: 'Mint', changes: [] }
      }
    ],
    events: []
  };
  job = null;
  const rpc = {
    getBlock: jest.fn(async (tag: number | string) => ({
      number: tag === 'finalized' ? 100 : tag,
      hash: `hash-${tag}`
    })),
    getTransaction: jest.fn(async () => ({ blockNumber: 1, index: 0 }))
  };
  jest
    .mocked(getEthereumRpcClient)
    .mockReturnValue(rpc as unknown as ReturnType<typeof getEthereumRpcClient>);
  jest.mocked(discoverClaimUpdates).mockResolvedValue(
    [2, 3].map(
      (blockNumber) =>
        ({
          blockNumber,
          transactionHash: `tx-${blockNumber}`,
          logIndex: 1,
          address: 'extension'
        }) as Log
    )
  );
  jest
    .mocked(decodeClaimUpdate)
    .mockImplementation(async (log) =>
      event(log.blockNumber, log.blockNumber === 2 ? 'B' : 'C')
    );
  jest
    .mocked(describeHistoryEdit)
    .mockImplementation(async (from, to) =>
      from === to
        ? null
        : { event: 'Edit', changes: [{ key: 'uri', from, to }] }
    );
  jest.mocked(nftHistoryDb.snapshot).mockImplementation(async () => state);
  jest
    .mocked(nftHistoryDb.apply)
    .mockImplementation(async (plan, afterWrite) => {
      state = applyVirtualPlan(state, plan);
      await afterWrite?.({} as never);
    });
  jest.mocked(nftHistoryReplayDb.find).mockImplementation(async () => job);
  jest
    .mocked(nftHistoryReplayDb.create)
    .mockImplementation(async (id, digest, requestRange, manifest) => {
      job = {
        job_id: id,
        digest,
        next_index: 0,
        request_json: canonicalJson(requestRange),
        manifest_json: canonicalJson(manifest),
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
  if (originalFlag === undefined)
    delete process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
  else process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED = originalFlag;
});

it('produces a read-only chronological manifest without creating jobs or changing history', async () => {
  const report = await dryReport();
  expect(report.applicable).toBe(true);
  expect(
    report.manifest.entries.map((entry) => entry.plan.previous_uri)
  ).toEqual(['A', 'B']);
  expect(state.events).toEqual([]);
  expect(nftHistoryDb.apply).not.toHaveBeenCalled();
  expect(nftHistoryReplayDb.find).not.toHaveBeenCalled();
  expect(nftHistoryReplayDb.create).not.toHaveBeenCalled();
  expect((await dryReport()).approvalDigest).toBe(report.approvalDigest);
});

it('defaults to disabled apply even with a valid reviewed digest', async () => {
  const report = await dryReport();
  delete process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED;
  await expect(
    runHistoryReplay(applyRequest(report.approvalDigest), () => 900000)
  ).rejects.toThrow('disabled');
  expect(nftHistoryReplayDb.find).not.toHaveBeenCalled();
  expect(nftHistoryDb.apply).not.toHaveBeenCalled();
});

it('rejects a stale approval before creating a job or writing history', async () => {
  await expect(
    runHistoryReplay(applyRequest('a'.repeat(64)), () => 900000)
  ).rejects.toThrow('changed since approval');
  expect(nftHistoryReplayDb.create).not.toHaveBeenCalled();
  expect(nftHistoryDb.apply).not.toHaveBeenCalled();
});

it('applies only the approved events, checkpoints each transaction, and is idempotent on retry', async () => {
  const report = await dryReport();
  const result = await runHistoryReplay(
    applyRequest(report.approvalDigest),
    () => 900000
  );
  expect(result).toEqual(
    expect.objectContaining({ complete: true, nextIndex: 2, nextFromBlock: 21 })
  );
  expect(state.events.map((row) => row.uri)).toEqual(['B', 'C']);
  expect(job!.next_index).toBe(2);
  expect(nftHistoryReplayDb.advance).toHaveBeenCalledTimes(2);
  await runHistoryReplay(applyRequest(report.approvalDigest), () => 900000);
  expect(nftHistoryDb.apply).toHaveBeenCalledTimes(2);
});

it('resumes the saved approved manifest after its time budget is exhausted', async () => {
  const report = await dryReport();
  let calls = 0;
  const partial = await runHistoryReplay(
    applyRequest(report.approvalDigest),
    () => (++calls <= 3 ? 900000 : 0)
  );
  expect(partial).toEqual(
    expect.objectContaining({
      complete: false,
      nextIndex: 1,
      nextFromBlock: null
    })
  );
  expect(state.events).toHaveLength(1);
  await expect(
    runHistoryReplay(applyRequest(report.approvalDigest), () => 900000)
  ).resolves.toEqual(expect.objectContaining({ complete: true, nextIndex: 2 }));
  expect(state.events).toHaveLength(2);
});

it('reports failed fetches and blocks the entire proposed window', async () => {
  jest
    .mocked(describeHistoryEdit)
    .mockRejectedValue(new Error('metadata unavailable'));
  const report = await dryReport();
  expect(report.applicable).toBe(false);
  expect(report.manifest.failures).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        transaction_hash: 'tx-2',
        error: 'metadata unavailable'
      })
    ])
  );
  await expect(
    runHistoryReplay(applyRequest(report.approvalDigest), () => 900000)
  ).rejects.toThrow('unresolved failures');
  expect(nftHistoryReplayDb.create).not.toHaveBeenCalled();
  expect(nftHistoryDb.apply).not.toHaveBeenCalled();
});

it('stops a resumed job if a successor plan or metadata changes', async () => {
  const report = await dryReport();
  let calls = 0;
  await runHistoryReplay(applyRequest(report.approvalDigest), () =>
    ++calls <= 3 ? 900000 : 0
  );
  jest.mocked(describeHistoryEdit).mockResolvedValue({
    event: 'Edit',
    changes: [{ key: 'image', from: 'old', to: 'changed-after-review' }]
  });
  await expect(
    runHistoryReplay(applyRequest(report.approvalDigest), () => 900000)
  ).rejects.toThrow('changed since approval');
  expect(job!.next_index).toBe(1);
  expect(state.events).toHaveLength(1);
});

it('does not reuse a job ID with another range or digest', async () => {
  const report = await dryReport();
  await runHistoryReplay(applyRequest(report.approvalDigest), () => 900000);
  await expect(
    runHistoryReplay(applyRequest('a'.repeat(64)), () => 900000)
  ).rejects.toThrow('already bound');
});

it('reports unmapped or unsupported events instead of omitting them', async () => {
  jest.mocked(decodeClaimUpdate).mockRejectedValue(new Error('Unmapped claim'));
  const report = await dryReport();
  expect(report.manifest.entries).toEqual([]);
  expect(report.manifest.failures).toHaveLength(2);
  expect(report.applicable).toBe(false);
});
