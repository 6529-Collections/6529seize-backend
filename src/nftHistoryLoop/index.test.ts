import { doInDbContext } from '@/secrets';
import { findNFTHistory } from '@/nft_history';
import { runSourceReplay } from '@/nft-history/source-replay';
import { runHistoryReplay } from '@/nft-history/replay';
import {
  NFTHistory,
  NFTHistoryBlock,
  NFTHistoryClaim
} from '@/entities/INFTHistory';
import { NFTHistoryEventEntity } from '@/entities/INFTHistoryEvent';
import { NFTHistoryReplayJobEntity } from '@/entities/INFTHistoryReplayJob';
import { handler } from './index';

jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (fn: () => Promise<unknown>) => fn())
}));
jest.mock('@/nft_history', () => ({ findNFTHistory: jest.fn() }));
jest.mock('@/nft-history/source-replay', () => ({
  ...jest.requireActual('@/nft-history/source-replay'),
  runSourceReplay: jest.fn().mockResolvedValue({ sourceReceipt: true })
}));
jest.mock('@/nft-history/replay', () => ({
  runHistoryReplay: jest.fn().mockResolvedValue({ receipt: true })
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn() }) }
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
const invoke = handler as (
  event: unknown,
  context?: unknown
) => Promise<unknown>;
const payload = {
  mode: 'nft-history-replay',
  action: 'dry-run',
  fromBlock: 1,
  toBlock: 2000,
  cutoffBlock: 3000
};
beforeEach(() => jest.clearAllMocks());

it('returns replay results and never runs the scheduled checkpoint path', async () => {
  await expect(
    invoke(payload, { getRemainingTimeInMillis: () => 123456 })
  ).resolves.toEqual({ receipt: true });
  expect(findNFTHistory).not.toHaveBeenCalled();
  expect(runHistoryReplay).toHaveBeenCalledWith(payload, expect.any(Function));
  const options = jest.mocked(doInDbContext).mock.calls[0][1];
  expect(options?.skipRedis).toBe(true);
  expect(options?.entities).toEqual([
    NFTHistory,
    NFTHistoryClaim,
    NFTHistoryEventEntity,
    NFTHistoryReplayJobEntity
  ]);
  expect(options?.entities).not.toContain(NFTHistoryBlock);
  expect(options?.syncEntities).toBe(false);
});

it('retains the existing scheduled ingestion behavior', async () => {
  await invoke({ source: 'aws.events', 'detail-type': 'Scheduled Event' });
  expect(findNFTHistory).toHaveBeenCalledTimes(1);
  expect(runHistoryReplay).not.toHaveBeenCalled();
});

it('rejects malformed requests before opening a database context', async () => {
  await expect(invoke({ ...payload, toBlock: 4000 })).rejects.toThrow();
  expect(doInDbContext).not.toHaveBeenCalled();
});

it('routes source-recovery audits without registering or changing the normal checkpoint', async () => {
  const sourceRequest = { ...payload, mode: 'nft-history-source-replay' };
  await expect(invoke(sourceRequest)).resolves.toEqual({ sourceReceipt: true });
  expect(runSourceReplay).toHaveBeenCalledWith(
    sourceRequest,
    expect.any(Function)
  );
  expect(findNFTHistory).not.toHaveBeenCalled();
  const options = jest.mocked(doInDbContext).mock.calls[0][1];
  expect(options?.entities).not.toContain(NFTHistoryBlock);
  expect(options?.syncEntities).toBe(false);
  expect(options?.skipRedis).toBe(true);
});
