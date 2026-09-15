import { DataSource } from 'typeorm';
import { connect, disconnect, getDataSource } from '@/db';
import * as environment from '@/env';
import { doInDbContext } from '@/secrets';
import { setSqlExecutor, sqlExecutor, SqlExecutor } from '@/sql-executor';

describe('Explicit loop database selection and lifecycle', () => {
  let originalName: string | undefined;
  let observer: SqlExecutor;
  beforeEach(() => {
    originalName = process.env.DB_NAME;
    observer = sqlExecutor;
  });
  afterEach(async () => {
    if (getDataSource()?.isInitialized) await disconnect();
    setSqlExecutor(observer);
    process.env.DB_NAME = originalName;
    jest.restoreAllMocks();
  });

  it('uses the captured internal database after secret loading overwrites environment selection', async () => {
    const selection = {
      database: originalName!,
      failOnInitializationError: true as const
    };
    jest.spyOn(environment, 'prepEnvironment').mockImplementation(async () => {
      process.env.DB_NAME = 'm4_unavailable_environment_destination';
      selection.database = 'm4_mutated_selection';
    });
    await expect(
      doInDbContext(
        async () => {
          expect(getDataSource().isInitialized).toBe(true);
          expect(getDataSource().options.synchronize).toBe(false);
          return getDataSource().query(
            'SELECT DATABASE() AS selected_database'
          );
        },
        {
          entities: [],
          syncEntities: false,
          skipRedis: true,
          databaseSelection: selection
        }
      )
    ).resolves.toEqual([{ selected_database: originalName }]);
    expect(getDataSource().isInitialized).toBe(false);
    expect(process.env.DB_NAME).toBe('m4_unavailable_environment_destination');
  });

  it('rejects a missing destination before callback or executor publication without falling back', async () => {
    jest.spyOn(environment, 'prepEnvironment').mockResolvedValue(undefined);
    const callback = jest.fn(async () => undefined);
    await expect(
      doInDbContext(callback, {
        entities: [],
        syncEntities: false,
        skipRedis: true,
        databaseSelection: {
          database: 'm4_unavailable_selected_destination',
          failOnInitializationError: true
        }
      })
    ).rejects.toBeDefined();
    expect(callback).not.toHaveBeenCalled();
    expect(sqlExecutor).toBe(observer);
    expect(getDataSource().isInitialized).toBe(false);
  });

  it('disposes an actual driver pool after failure before TypeORM marks initialization complete', async () => {
    const failure = new Error('fixture failure after actual pool acquisition');
    jest
      .spyOn(DataSource.prototype, 'initialize')
      .mockImplementationOnce(async function (this: DataSource) {
        await this.driver.connect();
        throw failure;
      });
    await expect(
      connect([], false, {
        database: originalName!,
        failOnInitializationError: true
      })
    ).rejects.toBe(failure);
    expect(getDataSource().isInitialized).toBe(false);
    expect(getDataSource().driver).toMatchObject({ pool: undefined });
    expect(sqlExecutor).toBe(observer);
  });

  it('disposes the actual context after a callback throws', async () => {
    jest.spyOn(environment, 'prepEnvironment').mockResolvedValue(undefined);
    const failure = new Error('fixture callback failure');
    await expect(
      doInDbContext(
        async () => {
          await getDataSource().query('SELECT 1');
          throw failure;
        },
        {
          skipRedis: true,
          databaseSelection: {
            database: originalName!,
            failOnInitializationError: true
          }
        }
      )
    ).rejects.toBe(failure);
    expect(getDataSource().isInitialized).toBe(false);
  });

  it('supports an explicit server-only setup connection without selecting the environment database', async () => {
    await connect([], false, {
      database: null,
      failOnInitializationError: true
    });
    expect(
      await getDataSource().query('SELECT DATABASE() AS selected_database')
    ).toEqual([{ selected_database: null }]);
  });

  it('rejects invalid selection and autosync before opening the destination', async () => {
    await expect(
      connect([], true, {
        database: originalName!,
        failOnInitializationError: true
      })
    ).rejects.toThrow('Invalid explicit database selection');
    await expect(
      connect([], false, {
        database: 'invalid/name',
        failOnInitializationError: true
      })
    ).rejects.toThrow('Invalid explicit database selection');
    expect(sqlExecutor).toBe(observer);
  });
});
