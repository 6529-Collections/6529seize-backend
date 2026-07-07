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

function nextgenCollection(id: number) {
  return { base_uri: `metadata/${id}/`, id, name: `Collection ${id}` } as any;
}

function tokenMetadata(collection: { base_uri: string }, tokenId: number) {
  const metadataLink = `${collection.base_uri}${tokenId}`;
  return {
    metadataLink,
    metadataResponse: { image: `image-${tokenId}` },
    name: `Token ${tokenId}`,
    pending: false
  };
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
      .mockResolvedValue([nextgenCollection(1)]);
    jest
      .spyOn(nextgenDb, 'fetchNextGenTokensForCollection')
      .mockResolvedValue([nextgenToken(1), nextgenToken(2)] as any);
    jest
      .spyOn(nftOwnersDb, 'fetchAllNftOwners')
      .mockResolvedValue([{ token_id: 1, wallet: 'NEW' }] as any);
    jest
      .spyOn(coreEvents, 'fetchNextGenTokenMetadata')
      .mockImplementation(async (collection, tokenId) =>
        tokenMetadata(collection, tokenId)
      );
    jest
      .spyOn(coreEvents, 'persistTokenWithMetadata')
      .mockResolvedValue(undefined);
    jest.spyOn(tokens, 'refreshNextgenTokens').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('updates all tokens and refreshes collection', async () => {
    await refreshNextgenMetadata();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(coreEvents.fetchNextGenTokenMetadata).toHaveBeenCalledTimes(2);
    expect(coreEvents.persistTokenWithMetadata).toHaveBeenCalledTimes(2);
    expect(coreEvents.persistTokenWithMetadata).toHaveBeenCalledWith(
      entityManager,
      nextgenCollection(1),
      1,
      'n1',
      'new',
      'md1',
      'mp1',
      'bd1',
      'hr1',
      'd1',
      tokenMetadata(nextgenCollection(1), 1)
    );
    expect(coreEvents.persistTokenWithMetadata).toHaveBeenCalledWith(
      entityManager,
      nextgenCollection(1),
      2,
      'n2',
      'o2',
      'md2',
      'mp2',
      'bd2',
      'hr2',
      'd2',
      tokenMetadata(nextgenCollection(1), 2)
    );
    expect(tokens.refreshNextgenTokens).toHaveBeenCalledWith(entityManager);
  });

  it('retries the atomic refresh transaction on deadlock', async () => {
    const deadlock = new Error(
      'ER_LOCK_DEADLOCK: Deadlock found when trying to get lock; try restarting transaction'
    ) as Error & { code: string };
    deadlock.code = 'ER_LOCK_DEADLOCK';
    dataSource.transaction
      .mockRejectedValueOnce(deadlock)
      .mockImplementation(async (fn: any) => await fn(entityManager));

    await refreshNextgenMetadata();

    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(coreEvents.persistTokenWithMetadata).toHaveBeenCalledTimes(2);
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
      .spyOn(coreEvents, 'fetchNextGenTokenMetadata')
      .mockImplementation(async (collection, tokenId) => {
        if (tokenId === 100) {
          throw new NextGenMetadataFetchError('fetch failed', true);
        }
        return tokenMetadata(collection, tokenId);
      });

    await refreshNextgenMetadata();

    expect(coreEvents.fetchNextGenTokenMetadata).toHaveBeenCalledTimes(100);
    expect(coreEvents.persistTokenWithMetadata).toHaveBeenCalledTimes(99);
    expect(tokens.refreshNextgenTokens).toHaveBeenCalledWith(entityManager);
  });

  it('applies the transient skip limit globally across collections', async () => {
    jest
      .spyOn(nextgenDb, 'fetchNextGenCollections')
      .mockResolvedValue([nextgenCollection(1), nextgenCollection(2)]);
    jest
      .spyOn(nextgenDb, 'fetchNextGenTokensForCollection')
      .mockImplementation(async () =>
        Array.from({ length: 300 }, (_, index) => nextgenToken(index + 1))
      );
    jest
      .spyOn(coreEvents, 'fetchNextGenTokenMetadata')
      .mockImplementation(async (collection, tokenId) => {
        if (tokenId <= 3) {
          throw new NextGenMetadataFetchError('fetch failed', true);
        }
        return tokenMetadata(collection, tokenId);
      });

    await expect(refreshNextgenMetadata()).rejects.toThrow(
      'Failed refreshing 6/600 tokens'
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('throws permanent metadata failures instead of skipping them', async () => {
    jest
      .spyOn(coreEvents, 'fetchNextGenTokenMetadata')
      .mockRejectedValueOnce(
        new NextGenMetadataFetchError('Invalid metadata payload', false)
      )
      .mockImplementation(async (collection, tokenId) =>
        tokenMetadata(collection, tokenId)
      );

    await expect(refreshNextgenMetadata()).rejects.toThrow(
      'Failed refreshing 1/2 tokens'
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
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
    jest
      .spyOn(coreEvents, 'fetchNextGenTokenMetadata')
      .mockImplementation(async (collection, tokenId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return tokenMetadata(collection, tokenId);
      });

    await refreshNextgenMetadata();

    expect(maxActive).toBeLessThanOrEqual(20);
    expect(maxActive).toBeGreaterThan(1);
  });
});
