import { SqlExecutor } from '@/sql-executor';
import {
  FACADE_LOCK_WAIT_SECONDS,
  FACADE_REPLACE_RETRY_DELAYS_MS,
  installLegacyCompetitionGetFacade,
  LEGACY_GET_SOURCE_TABLES,
  legacyGetView
} from './legacy-competition-get-facade';

type Params = Record<string, unknown>;

interface FakeView {
  view_definition: string;
  security_type: string;
  character_set_client: string;
  collation_connection: string;
}

/**
 * In-memory MySQL stand-in: views are stored with a "normalized" definition
 * (whitespace collapsed), information_schema reads return them, and replacing
 * a chosen view can fail with a metadata lock timeout.
 */
function fakeDatabase({
  installed = new Map<string, FakeView>(),
  lockedViews = new Map<string, number>()
}: {
  installed?: Map<string, FakeView>;
  lockedViews?: Map<string, number>;
} = {}) {
  const statements: string[] = [];
  const normalize = (definition: string) => definition.replace(/\s+/g, ' ');
  const asView = (definition: string): FakeView => ({
    view_definition: normalize(definition),
    security_type: 'INVOKER',
    character_set_client: 'utf8mb4',
    collation_connection: 'utf8mb4_0900_ai_ci'
  });
  const execute = jest.fn(async (sql: string, params: Params = {}) => {
    statements.push(sql);
    let match =
      /^create or replace sql security invoker view `([^`]+)` as ([\s\S]+)$/.exec(
        sql
      );
    if (match) {
      const remaining = lockedViews.get(match[1]) ?? 0;
      if (remaining > 0) {
        lockedViews.set(match[1], remaining - 1);
        throw Object.assign(new Error('Lock wait timeout exceeded'), {
          code: 'ER_LOCK_WAIT_TIMEOUT',
          errno: 1205
        });
      }
      installed.set(match[1], asView(match[2]));
      return [];
    }
    match = /^create sql security invoker view `([^`]+)` as ([\s\S]+)$/.exec(
      sql
    );
    if (match) {
      installed.set(match[1], asView(match[2]));
      return [];
    }
    match = /^drop view if exists `([^`]+)`$/.exec(sql);
    if (match) {
      installed.delete(match[1]);
      return [];
    }
    return [];
  });
  const oneOrNull = jest.fn(async (sql: string, params: Params = {}) => {
    statements.push(sql);
    if (sql.includes('@@session.lock_wait_timeout'))
      return { timeout: 31536000 };
    if (sql.includes('information_schema.views'))
      return installed.get(params.view as string) ?? null;
    return null;
  });
  const db = {
    execute,
    oneOrNull,
    executeNativeQueriesInTransaction: jest.fn(
      async (action: (connection: unknown) => Promise<unknown>) =>
        action({ connection: {} })
    )
  } as unknown as SqlExecutor;
  return { db, statements, installed, execute };
}

const replacements = (statements: string[]) =>
  statements.filter((sql) => sql.startsWith('create or replace'));
const noSleep = jest.fn(async (_ms: number) => undefined);

describe('installLegacyCompetitionGetFacade', () => {
  beforeEach(() => noSleep.mockClear());

  it('creates every view on an empty schema', async () => {
    const { db, statements } = fakeDatabase();
    const result = await installLegacyCompetitionGetFacade(db, {
      sleep: noSleep
    });
    expect(result.replaced).toHaveLength(LEGACY_GET_SOURCE_TABLES.length);
    expect(result.unchanged).toEqual([]);
    expect(replacements(statements)).toHaveLength(
      LEGACY_GET_SOURCE_TABLES.length
    );
  });

  it('skips unchanged views without touching them', async () => {
    const { db, installed } = fakeDatabase();
    await installLegacyCompetitionGetFacade(db, { sleep: noSleep });

    const second = fakeDatabase({ installed });
    const result = await installLegacyCompetitionGetFacade(second.db, {
      sleep: noSleep
    });
    expect(result.replaced).toEqual([]);
    expect(result.unchanged).toHaveLength(LEGACY_GET_SOURCE_TABLES.length);
    expect(replacements(second.statements)).toEqual([]);
    // Throwaway comparison views are always dropped again.
    expect(
      Array.from(installed.keys()).filter((name) =>
        name.startsWith('lgf_candidate_')
      )
    ).toEqual([]);
  });

  it('replaces only the view whose definition changed', async () => {
    const { db, installed } = fakeDatabase();
    await installLegacyCompetitionGetFacade(db, { sleep: noSleep });
    const changed = legacyGetView(LEGACY_GET_SOURCE_TABLES[2]);
    installed.set(changed, {
      ...installed.get(changed)!,
      view_definition: 'select 1 as `stale`'
    });

    const second = fakeDatabase({ installed });
    const result = await installLegacyCompetitionGetFacade(second.db, {
      sleep: noSleep
    });
    expect(result.replaced).toEqual([changed]);
    expect(replacements(second.statements)).toHaveLength(1);
  });

  it('waits at most the short lock timeout and restores the session', async () => {
    const { db, statements } = fakeDatabase();
    await installLegacyCompetitionGetFacade(db, { sleep: noSleep });
    expect(db.execute).toHaveBeenCalledWith(
      'set session lock_wait_timeout=:lockWaitSeconds',
      { lockWaitSeconds: FACADE_LOCK_WAIT_SECONDS },
      expect.anything()
    );
    expect(statements.at(-1)).toBe('set session lock_wait_timeout=:timeout');
    expect(db.execute).toHaveBeenLastCalledWith(
      'set session lock_wait_timeout=:timeout',
      { timeout: 31536000 },
      expect.anything()
    );
  });

  it('retries a locked view with backoff and then replaces it', async () => {
    const view = legacyGetView(LEGACY_GET_SOURCE_TABLES[0]);
    const { db, statements } = fakeDatabase({
      lockedViews: new Map([[view, 2]])
    });
    const result = await installLegacyCompetitionGetFacade(db, {
      sleep: noSleep
    });
    expect(result.replaced).toContain(view);
    expect(
      replacements(statements).filter((sql) => sql.includes(`\`${view}\``))
    ).toHaveLength(3);
    expect(noSleep.mock.calls.map(([ms]) => ms)).toEqual([
      ...FACADE_REPLACE_RETRY_DELAYS_MS
    ]);
  });

  it('fails cleanly when a view stays locked, still restoring the session', async () => {
    const view = legacyGetView(LEGACY_GET_SOURCE_TABLES[1]);
    const { db, statements } = fakeDatabase({
      lockedViews: new Map([[view, 99]])
    });
    await expect(
      installLegacyCompetitionGetFacade(db, { sleep: noSleep })
    ).rejects.toThrow(`Facade view ${view} stayed locked after 3 attempts`);
    expect(statements.at(-1)).toBe('set session lock_wait_timeout=:timeout');
  });

  it('does not retry other errors', async () => {
    const { db, execute } = fakeDatabase();
    const failure = new Error('syntax');
    execute.mockImplementationOnce(async () => []); // lock timeout setting
    execute.mockImplementationOnce(async () => {
      throw failure;
    });
    await expect(
      installLegacyCompetitionGetFacade(db, { sleep: noSleep })
    ).rejects.toBe(failure);
    expect(noSleep).not.toHaveBeenCalled();
  });
});
