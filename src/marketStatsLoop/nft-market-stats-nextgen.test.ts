jest.mock('../db', () => ({ getDataSource: jest.fn() }));
jest.mock('../nextgen/nextgen.db', () => ({
  fetchNextgenTokens: jest.fn(),
  persitNextgenTokenListings: jest.fn()
}));
jest.mock('../logging', () => ({
  Logger: {
    get: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    })
  }
}));

import { getDataSource } from '../db';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import {
  fetchNextgenTokens,
  persitNextgenTokenListings
} from '../nextgen/nextgen.db';
import { NEXTGEN_ROYALTIES_ADDRESS } from '../nextgen/nextgen_constants';
import {
  fetchOpenSeaCollectionListings,
  findNextgenMarketStats,
  getOpenSeaCollectionSlug,
  getOpenSeaListingStats,
  indexBestOpenSeaListingsByTokenId,
  OpenSeaListing,
  withNextgenDatabaseDeadline
} from './nft_market_stats_nextgen';

const fetchMock = jest.fn();
const originalFetch = global.fetch;

function jsonResponse(
  body: unknown,
  options: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    text?: string;
  } = {}
): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(options.text ?? JSON.stringify(body))
  } as unknown as Response;
}

function listing(
  tokenId: string,
  priceWei: string,
  orderHash: string
): OpenSeaListing {
  return {
    price: {
      current: {
        decimals: 18,
        value: priceWei
      }
    },
    protocol_data: {
      parameters: {
        offer: [
          {
            identifierOrCriteria: tokenId
          }
        ]
      }
    },
    order_hash: orderHash
  } as OpenSeaListing;
}

describe('NextGen OpenSea market stats helpers', () => {
  beforeEach(() => {
    process.env.OPENSEA_API_KEY = 'opensea-key';
    fetchMock.mockReset();
    jest.mocked(persitNextgenTokenListings).mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    delete process.env.OPENSEA_API_KEY;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves the OpenSea collection slug from the contract endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ collection: 'pebbles-by-zeblocks' })
    );

    await expect(getOpenSeaCollectionSlug('0xabc')).resolves.toBe(
      'pebbles-by-zeblocks'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.opensea.io/api/v2/chain/ethereum/contract/0xabc',
      {
        headers: {
          accept: 'application/json',
          'x-api-key': 'opensea-key'
        },
        signal: expect.any(AbortSignal)
      }
    );
  });

  it('fetches all paginated OpenSea collection listings', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          listings: [listing('1', '1000000000000000000', 'first')],
          next: 'cursor-1'
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          listings: [listing('2', '2000000000000000000', 'second')],
          next: null
        })
      );

    const listings = await fetchOpenSeaCollectionListings(
      'pebbles-by-zeblocks'
    );

    expect(listings).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(firstUrl.pathname).toBe(
      '/api/v2/listings/collection/pebbles-by-zeblocks/all'
    );
    expect(firstUrl.searchParams.get('limit')).toBe('100');
    expect(firstUrl.searchParams.has('next')).toBe(false);

    const secondUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(secondUrl.searchParams.get('limit')).toBe('100');
    expect(secondUrl.searchParams.get('next')).toBe('cursor-1');
  });

  it('indexes the lowest positive OpenSea listing price by token id', () => {
    const listings = [
      listing('1', '3000000000000000000', 'expensive'),
      listing('1', '1000000000000000000', 'cheap'),
      listing('2', '0', 'invalid'),
      listing('2', '2000000000000000000', 'valid')
    ];

    const indexed = indexBestOpenSeaListingsByTokenId(listings);

    expect(indexed.get('1')).toEqual(listings[1]);
    expect(indexed.get('2')).toEqual(listings[3]);
  });

  it('extracts listing stats from the new OpenSea response shape', () => {
    const stats = getOpenSeaListingStats({
      price: {
        current: {
          decimals: 18,
          value: '1000000000000000000'
        }
      },
      protocol_data: {
        parameters: {
          consideration: [
            {
              recipient: NEXTGEN_ROYALTIES_ADDRESS,
              startAmount: '25000000000000000'
            }
          ],
          endTime: '456',
          startTime: '123'
        }
      }
    });

    expect(stats).toEqual({
      expirationTime: 456,
      listingTime: 123,
      price: 1,
      royalty: 2.5
    });
  });

  it('extracts legacy maker fee royalty data when present', () => {
    const stats = getOpenSeaListingStats({
      current_price: '1000000000000000000',
      expiration_time: 456,
      listing_time: 123,
      maker_fees: [
        {
          account: {
            address: NEXTGEN_ROYALTIES_ADDRESS.toLowerCase()
          },
          basis_points: 750
        }
      ]
    });

    expect(stats).toEqual({
      expirationTime: 456,
      listingTime: 123,
      price: 1,
      royalty: 7.5
    });
  });

  it('throws for OpenSea failures instead of returning an empty listing set', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: 'server failed' },
        { ok: false, status: 500, statusText: 'Server Error', text: 'failed' }
      )
    );

    await expect(fetchOpenSeaCollectionListings('slug')).rejects.toThrow(
      'NextGen market stats provider HTTP 500'
    );
  });

  it('does not start legacy work after the invocation deadline', async () => {
    await expect(findNextgenMarketStats('0xabc', Date.now())).rejects.toThrow(
      'NextGen market stats deadline exceeded'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['headers', 'body'])(
    'aborts provider %s waits at the remaining invocation budget',
    async (stage) => {
      jest.useFakeTimers();
      fetchMock.mockImplementation((_url, options: RequestInit) => {
        const pending = new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new Error('request aborted'))
          );
        });
        return stage === 'headers'
          ? pending
          : Promise.resolve({ ok: true, json: () => pending });
      });
      const result = expect(
        getOpenSeaCollectionSlug('0xabc', Date.now() + 250)
      ).rejects.toThrow('request aborted');
      await jest.advanceTimersByTimeAsync(250);
      await result;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('does not request another listing page after the shared deadline', async () => {
    jest.useFakeTimers();
    const deadline = Date.now() + 100;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        jest.setSystemTime(deadline);
        return { listings: [], next: 'next-page' };
      }
    });
    await expect(
      fetchOpenSeaCollectionListings('slug', deadline)
    ).rejects.toThrow('deadline exceeded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['batch', 'delay'])(
    'stops the transaction before further batches when the %s consumes the budget',
    async (stage) => {
      jest.useFakeTimers();
      const deadline = Date.now() + 1000;
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ collection: 'slug' }))
        .mockResolvedValueOnce(jsonResponse({ listings: [] }))
        .mockResolvedValueOnce(jsonResponse({ tokens: [] }));
      const transaction = jest.fn(async (callback) =>
        callback({
          queryRunner: {
            isTransactionActive: true,
            connect: async () => ({ query: jest.fn(), destroy: jest.fn() })
          }
        })
      );
      jest
        .mocked(getDataSource)
        .mockReturnValue({ transaction } as unknown as ReturnType<
          typeof getDataSource
        >);
      jest
        .mocked(fetchNextgenTokens)
        .mockResolvedValue(
          Array.from({ length: 31 }, (_, id) => ({ id })) as Awaited<
            ReturnType<typeof fetchNextgenTokens>
          >
        );
      jest.mocked(persitNextgenTokenListings).mockImplementation(async () => {
        jest.setSystemTime(stage === 'batch' ? deadline : deadline - 400);
      });

      await expect(findNextgenMarketStats('0xabc', deadline)).rejects.toThrow(
        'deadline exceeded'
      );
      expect(persitNextgenTokenListings).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    }
  );
});

describe('NextGen transaction query deadlines', () => {
  afterEach(() => jest.useRealTimers());

  it.each([10_000, 1_234])(
    'caps the native query timeout at the remaining %ims and restores the connection method',
    async (budget) => {
      jest.useFakeTimers();
      const originalQuery = jest.fn((_sql, _parameters, callback) =>
        callback(null, ['result'])
      );
      const connection = { query: originalQuery, destroy: jest.fn() };
      const manager = {
        queryRunner: {
          isTransactionActive: true,
          connect: async () => connection
        }
      } as unknown as EntityManager;
      const result = await withNextgenDatabaseDeadline(
        manager,
        Date.now() + budget,
        () =>
          new Promise((resolve, reject) => {
            connection.query(
              { sql: 'SELECT id FROM nextgen_tokens', timeout: 90_000 },
              [],
              (error: Error | null, rows: unknown) =>
                error ? reject(error) : resolve(rows)
            );
          })
      );
      expect(result).toEqual(['result']);
      expect(originalQuery.mock.calls[0][0].timeout).toBeLessThanOrEqual(
        Math.min(5_000, budget)
      );
      expect(originalQuery.mock.calls[0][0].timeout).toBeGreaterThan(0);
      expect(connection.query).toBe(originalQuery);
      expect(connection.destroy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it.each([
    'SELECT id FROM nextgen_tokens',
    'INSERT INTO nextgen_token_listings VALUES (?)'
  ])(
    'discards a timed-out connection and lets TypeORM roll back and release for %s',
    async (sql) => {
      jest.useFakeTimers();
      const cleanup: string[] = [];
      const originalQuery = jest.fn((options, _parameters, callback) => {
        setTimeout(
          () =>
            callback(
              Object.assign(new Error('query timed out'), {
                code: 'PROTOCOL_SEQUENCE_TIMEOUT'
              })
            ),
          Math.min(50, options.timeout)
        );
      });
      const connection = {
        query: originalQuery,
        destroy: jest.fn(() => {
          cleanup.push('destroy');
        })
      };
      const runner = {
        isTransactionActive: true,
        connect: async () => connection,
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(async () => {
          cleanup.push('rollback');
          throw new Error('connection closed');
        }),
        release: jest.fn(async () => {
          cleanup.push('release');
        }),
        manager: undefined as unknown as EntityManager
      };
      const dataSource = {
        createQueryRunner: () => runner
      } as unknown as DataSource;
      runner.manager = new EntityManager(
        dataSource,
        runner as unknown as QueryRunner
      );
      const afterQuery = jest.fn();
      const transaction = new EntityManager(dataSource).transaction(
        async (manager) => {
          await withNextgenDatabaseDeadline(
            manager,
            Date.now() + 250,
            () =>
              new Promise((resolve, reject) => {
                connection.query(
                  sql,
                  [],
                  (error: Error | null, rows: unknown) =>
                    error ? reject(error) : resolve(rows)
                );
              })
          );
          afterQuery();
        }
      );
      const rejected = expect(transaction).rejects.toThrow('query timed out');
      await jest.advanceTimersByTimeAsync(250);
      await rejected;
      expect(afterQuery).not.toHaveBeenCalled();
      expect(runner.commitTransaction).not.toHaveBeenCalled();
      expect(cleanup).toEqual(['destroy', 'rollback', 'release']);
      expect(connection.query).toBe(originalQuery);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('enforces the wall-clock deadline when the driver does not report a timeout and ignores late callbacks', async () => {
    jest.useFakeTimers();
    let nativeCallback:
      | ((error: Error | null, result?: unknown) => void)
      | undefined;
    const originalQuery = jest.fn((_sql, _parameters, callback) => {
      nativeCallback = callback;
    });
    const cleanup: string[] = [];
    const connection = {
      query: originalQuery,
      destroy: jest.fn(() => {
        cleanup.push('destroy');
      })
    };
    const manager = {
      queryRunner: {
        isTransactionActive: true,
        connect: async () => connection
      }
    } as unknown as EntityManager;
    const callback = jest.fn();
    const operation = withNextgenDatabaseDeadline(
      manager,
      Date.now() + 250,
      () =>
        new Promise((resolve, reject) => {
          connection.query(
            'SELECT slowly_streamed_rows',
            [],
            (error: Error | null, result: unknown) => {
              cleanup.push('callback');
              callback(error);
              if (error) reject(error);
              else resolve(result);
            }
          );
        })
    );
    const rejected = expect(operation).rejects.toThrow(
      'NextGen database query deadline exceeded'
    );
    await jest.advanceTimersByTimeAsync(250);
    await rejected;
    nativeCallback?.(null, ['late row']);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(cleanup).toEqual(['destroy', 'callback']);
    expect(connection.query).toBe(originalQuery);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the wall-clock timer on a synchronous native query failure', async () => {
    jest.useFakeTimers();
    const originalQuery = jest.fn(() => {
      throw new Error('driver failure');
    });
    const connection = { query: originalQuery, destroy: jest.fn() };
    const manager = {
      queryRunner: {
        isTransactionActive: true,
        connect: async () => connection
      }
    } as unknown as EntityManager;
    await expect(
      withNextgenDatabaseDeadline(manager, Date.now() + 250, async () => {
        connection.query();
      })
    ).rejects.toThrow('driver failure');
    expect(connection.query).toBe(originalQuery);
    expect(jest.getTimerCount()).toBe(0);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it('does not dispatch a native query once the deadline has elapsed', async () => {
    const originalQuery = jest.fn();
    const connection = { query: originalQuery, destroy: jest.fn() };
    const manager = {
      queryRunner: {
        isTransactionActive: true,
        connect: async () => connection
      }
    } as unknown as EntityManager;
    await expect(
      withNextgenDatabaseDeadline(manager, Date.now(), async () => {
        connection.query('SELECT 1', [], jest.fn());
      })
    ).rejects.toThrow('deadline exceeded');
    expect(originalQuery).not.toHaveBeenCalled();
    expect(connection.query).toBe(originalQuery);
  });
});
