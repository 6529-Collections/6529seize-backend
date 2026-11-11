import { EntityManager } from 'typeorm';
import { getDataSource } from '@/db';
import { MEMES_CONTRACT } from '@/constants';
import { historyFingerprint, nftHistoryDb } from './history.db';
import { HistorySourcePlan, claimFingerprint } from './source-plan';
import { historySourceDb } from './source.db';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('./history.db', () => ({
  ...jest.requireActual('./history.db'),
  nftHistoryDb: { snapshot: jest.fn(), applyInTransaction: jest.fn() }
}));
const snapshot = { legacy: [], events: [] };
function fixture() {
  const query = {
    where: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined)
  };
  const manager = {
    getRepository: jest.fn(() => ({ createQueryBuilder: () => query })),
    query: jest.fn().mockResolvedValue(undefined)
  };
  const transaction = jest.fn(async (fn: (m: EntityManager) => Promise<void>) =>
    fn(manager as unknown as EntityManager)
  );
  jest
    .mocked(getDataSource)
    .mockReturnValue({ transaction } as unknown as ReturnType<
      typeof getDataSource
    >);
  jest.mocked(nftHistoryDb.snapshot).mockResolvedValue(snapshot);
  const plan: HistorySourcePlan = {
    claims: [
      {
        before: claimFingerprint([]),
        record: {
          contract: MEMES_CONTRACT,
          claimId: '12345',
          tokenId: 569,
          location: 'metadata'
        }
      }
    ],
    writes: [
      {
        kind: 'mint',
        before: historyFingerprint(snapshot),
        row: {
          contract: MEMES_CONTRACT,
          nft_id: 569,
          uri: 'https://arweave.net/metadata',
          block: 100,
          transaction_hash: 'tx',
          transaction_date: new Date(1000),
          created_at: new Date(),
          description: { event: 'Mint', changes: [] }
        }
      }
    ]
  };
  return { query, manager, transaction, plan };
}
beforeEach(() => jest.clearAllMocks());
it('commits mapping, native JSON Mint and replay cursor in one transaction', async () => {
  const { query, manager, transaction, plan } = fixture();
  const cursor = jest.fn();
  await historySourceDb.apply(plan, cursor);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(query.setLock).toHaveBeenCalledWith('pessimistic_write');
  expect(manager.query).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO nfts_history_claims'),
    [MEMES_CONTRACT, '12345', 'metadata', 569]
  );
  expect(query.setParameter).toHaveBeenCalledWith(
    'mintDescription',
    '{"event":"Mint","changes":[]}'
  );
  expect(cursor).toHaveBeenCalledWith(manager);
});
it('never writes or advances a cursor when the reviewed mapping fingerprint changed', async () => {
  const { manager, plan } = fixture();
  plan.claims[0].before = 'stale';
  const cursor = jest.fn();
  await expect(historySourceDb.apply(plan, cursor)).rejects.toThrow(
    'mapping changed'
  );
  expect(manager.query).not.toHaveBeenCalled();
  expect(cursor).not.toHaveBeenCalled();
});
it('propagates an unsuccessful Mint transaction without advancing the replay cursor', async () => {
  const { query, plan } = fixture();
  query.execute.mockRejectedValue(new Error('insert failed'));
  const cursor = jest.fn();
  await expect(historySourceDb.apply(plan, cursor)).rejects.toThrow(
    'insert failed'
  );
  expect(cursor).not.toHaveBeenCalled();
});
