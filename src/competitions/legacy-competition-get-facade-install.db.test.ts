import 'reflect-metadata';
import { WAVE_OUTCOMES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  FACADE_DDL_ATTEMPTS,
  installLegacyCompetitionGetFacade,
  LEGACY_GET_SOURCE_TABLES,
  legacyCompetitionGetViewDefinition,
  legacyGetView
} from './legacy-competition-get-facade';

const noSleep = async () => undefined;
const table = WAVE_OUTCOMES_TABLE;
const view = legacyGetView(table);

/** Gives the live view a definition that differs from the desired one. */
async function makeStale() {
  await sqlExecutor.execute(
    `create or replace sql security invoker view \`${view}\` as ${legacyCompetitionGetViewDefinition(table)} limit 1000000000`
  );
}

describe('installLegacyCompetitionGetFacade on MySQL', () => {
  afterEach(async () => {
    // Leave every view exactly as the facade defines it.
    await installLegacyCompetitionGetFacade(sqlExecutor, { sleep: noSleep });
  });

  it('recognizes installed views as unchanged and leaves them alone', async () => {
    await installLegacyCompetitionGetFacade(sqlExecutor, { sleep: noSleep });
    const result = await installLegacyCompetitionGetFacade(sqlExecutor, {
      sleep: noSleep
    });
    expect(result.replaced).toEqual([]);
    expect(result.unchanged).toHaveLength(LEGACY_GET_SOURCE_TABLES.length);
    const leftovers = await sqlExecutor.execute<{ name: string }>(
      `select table_name as name from information_schema.views
       where table_schema = database() and table_name like 'lgf\\_candidate\\_%'`
    );
    expect(leftovers).toEqual([]);
  });

  it('replaces only a view whose definition changed', async () => {
    await makeStale();
    const result = await installLegacyCompetitionGetFacade(sqlExecutor, {
      sleep: noSleep
    });
    expect(result.replaced).toEqual([view]);
  });

  it('gives up on a view held by a running reader instead of queueing behind it', async () => {
    await makeStale();
    let finishReader!: () => void;
    const readerDone = new Promise<void>((resolve) => (finishReader = resolve));
    let readerStarted!: () => void;
    const started = new Promise<void>((resolve) => (readerStarted = resolve));
    // An open transaction that has read the view holds its metadata lock.
    const reader = sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        await sqlExecutor.execute(
          `select count(*) from \`${view}\``,
          {},
          {
            wrappedConnection: connection
          }
        );
        readerStarted();
        await readerDone;
      }
    );
    await started;
    const execute = jest.spyOn(sqlExecutor, 'execute');
    try {
      await expect(
        installLegacyCompetitionGetFacade(sqlExecutor, { sleep: noSleep })
      ).rejects.toThrow(
        `Facade view ${view} stayed locked after ${FACADE_DDL_ATTEMPTS} attempts`
      );
      // Each attempt is one bounded wait; nothing queues open-endedly.
      expect(
        execute.mock.calls.filter(
          ([sql]) =>
            sql.startsWith('create or replace') && sql.includes(`\`${view}\``)
        )
      ).toHaveLength(FACADE_DDL_ATTEMPTS);
    } finally {
      execute.mockRestore();
      finishReader();
      await reader;
    }
    const retried = await installLegacyCompetitionGetFacade(sqlExecutor, {
      sleep: noSleep
    });
    expect(retried.replaced).toEqual([view]);
  }, 30_000);
});
