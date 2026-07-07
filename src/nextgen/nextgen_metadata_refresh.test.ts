import { refreshNextgenMetadata } from './nextgen_metadata_refresh';
import * as db from '../db';
import * as logging from '../logging';
import * as nftOwnersDb from '../nftOwnersLoop/db.nft_owners';
import * as nextgenDb from './nextgen.db';
import * as constants from './nextgen_constants';
import * as coreEvents from './nextgen_core_events';
import * as tokens from './nextgen_tokens';
import { NextGenMetadataFetchError } from './nextgen-metadata';

function nextgenToken(id: number) {
  return {
    id,
    normalised_id: `n${id}`,
    owner: `o${id}`,
    mint_date: `md${id}`,
    mint_price: `mp${id}`,
    burnt_date: `bd${id}`,
    hodl_rate: `hr${id}`,
    mint_data: `d${id}`
  } as any;
}

describe('refreshNextgenMetadata', () => {
  const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as any;
  const entityManager = {} as any;
  const dataSource = {
    manager: entityManager,
    transaction: jest.fn(async (fn: any) => await fn(entityManager))
  } as any;

  beforeEach(() => {
    dataSource.transaction.mockImplementation(
      async (fn: any) => await fn(entityManager)
    );
    jest.spyOn(db, 'getDataSource').mockReturnValue(dataSource);
    jest.spyOn(logging.Logger, 'get').mockReturnValue(logger);
    jest
      .spyOn(constants, 'getNextgenNetwork')
      .mockReturnValue('testnet' as any);
    (constants as any).NEXTGEN_CORE_CONTRACT = { testnet: '0xabc' } as any;
    jest
      .spyOn(nextgenDb, 'fetchNextGenCollections')
      .mockResolvedValue([{ id: 1 } as any]);
    jest
      .spyOn(nextgenDb, 'fetchNextGenTokensForCollection')
      .mockResolvedValue([nextgenToken(1), nextgenToken(2)] as any);
    jest
      .spyOn(nftOwnersDb, 'fetchAllNftOwners')
      .mockResolvedValue([{ token_id: 1, wallet: 'NEW' }] as any);
    jest.spyOn(coreEvents, 'upsertToken').mockResolvedValue(undefined);
    jest.spyOn(tokens, 'refreshNextgenTokens').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('updates all tokens and refreshes collection', async () => {
    await refreshNextgenMetadata();

    expect(dataSource.transaction).toHaveBeenCalledTimes(3);
    expect(coreEvents.upsertToken).toHaveBeenCalledTimes(2);
    expect(coreEvents.upsertToken).toHaveBeenCalledWith(
      entityManager,
      { id: 1 },
      1,
      'n1',
      'new',
      'md1',
      'mp1',
      'bd1',
      'hr1',
      'd1'
    );
    expect(coreEvents.upsertToken).toHaveBeenCalledWith(
      entityManager,
      { id: 1 },
      2,
      'n2',
      'o2',
      'md2',
      'mp2',
      'bd2',
      'hr2',
      'd2'
    );
    expect(tokens.refreshNextgenTokens).toHaveBeenCalledWith(entityManager);
  });

  it('retries token persistence deadlocks before recording a failure', async () => {
    const deadlock = new Error(
      'ER_LOCK_DEADLOCK: Deadlock found when trying to get lock; try restarting transaction'
    ) as Error & { code: string };
    deadlock.code = 'ER_LOCK_DEADLOCK';
    jest
      .spyOn(coreEvents, 'upsertToken')
      .mockRejectedValueOnce(deadlock)
      .mockResolvedValue(undefined);

    await refreshNextgenMetadata();

    expect(coreEvents.upsertToken).toHaveBeenCalledTimes(3);
    expect(tokens.refreshNextgenTokens).toHaveBeenCalledWith(entityManager);
  });

  it('skips tiny exhausted transient metadata failures and refreshes scores', async () => {
    const collectionTokens = Array.from({ length: 100 }, (_, index) =>
      nextgenToken(index + 1)
    );
    jest
      .spyOn(nextgenDb, 'fetchNextGenTokensForCollection')
      .mockResolvedValue(collectionTokens);
    jest
      .spyOn(coreEvents, 'upsertToken')
      .mockImplementation(async (_manager, _collection, tokenId) => {
        if (tokenId === 100) {
          throw new NextGenMetadataFetchError('fetch failed', true);
        }
      });

    await refreshNextgenMetadata();

    expect(coreEvents.upsertToken).toHaveBeenCalledTimes(100);
    expect(tokens.refreshNextgenTokens).toHaveBeenCalledWith(entityManager);
  });

  it('throws permanent metadata failures instead of skipping them', async () => {
    jest
      .spyOn(coreEvents, 'upsertToken')
      .mockRejectedValueOnce(
        new NextGenMetadataFetchError('Invalid metadata payload', false)
      )
      .mockResolvedValue(undefined);

    await expect(refreshNextgenMetadata()).rejects.toThrow(
      'Failed refreshing 1/2 tokens'
    );
    expect(tokens.refreshNextgenTokens).not.toHaveBeenCalled();
  });

  it('bounds token refresh concurrency', async () => {
    const collectionTokens = Array.from({ length: 25 }, (_, index) =>
      nextgenToken(index + 1)
    );
    jest
      .spyOn(nextgenDb, 'fetchNextGenTokensForCollection')
      .mockResolvedValue(collectionTokens);

    let active = 0;
    let maxActive = 0;
    jest.spyOn(coreEvents, 'upsertToken').mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });

    await refreshNextgenMetadata();

    expect(maxActive).toBeLessThanOrEqual(20);
    expect(maxActive).toBeGreaterThan(1);
  });
});
