import { refreshNextgenMetadata } from './nextgen_metadata_refresh';
import * as db from '../db';
import * as logging from '../logging';
import * as nftOwnersDb from '../nftOwnersLoop/db.nft_owners';
import * as nextgenDb from './nextgen.db';
import * as constants from './nextgen_constants';
import * as coreEvents from './nextgen_core_events';
import * as tokens from './nextgen_tokens';

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
    jest.spyOn(nextgenDb, 'fetchNextGenTokensForCollection').mockResolvedValue([
      {
        id: 1,
        normalised_id: 'n1',
        owner: 'o1',
        mint_date: 'md1',
        mint_price: 'mp1',
        burnt_date: 'bd1',
        hodl_rate: 'hr1',
        mint_data: 'd1'
      },
      {
        id: 2,
        normalised_id: 'n2',
        owner: 'o2',
        mint_date: 'md2',
        mint_price: 'mp2',
        burnt_date: 'bd2',
        hodl_rate: 'hr2',
        mint_data: 'd2'
      }
    ] as any);
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

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
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
    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(tokens.refreshNextgenTokens).toHaveBeenCalledWith(entityManager);
  });

  it('processes token writes sequentially inside the metadata transaction', async () => {
    const collectionTokens = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      normalised_id: `n${index + 1}`,
      owner: `o${index + 1}`,
      mint_date: `md${index + 1}`,
      mint_price: `mp${index + 1}`,
      burnt_date: `bd${index + 1}`,
      hodl_rate: `hr${index + 1}`,
      mint_data: `d${index + 1}`
    }));
    jest
      .spyOn(nextgenDb, 'fetchNextGenTokensForCollection')
      .mockResolvedValue(collectionTokens as any);

    let active = 0;
    let maxActive = 0;
    jest.spyOn(coreEvents, 'upsertToken').mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });

    await refreshNextgenMetadata();

    expect(maxActive).toBe(1);
  });
});
