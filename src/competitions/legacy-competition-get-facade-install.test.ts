import { SqlExecutor } from '@/sql-executor';
import {
  FACADE_DDL_ATTEMPTS,
  FACADE_LOCK_WAIT_SECONDS,
  FACADE_RETRY_DELAYS_MS,
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

const lockTimeout = () =>
  Object.assign(new Error('Lock wait timeout exceeded'), {
    code: 'ER_LOCK_WAIT_TIMEOUT',
    errno: 1205
  });

/**
 * In-memory MySQL stand-in: views are stored with a "normalized" definition
 * (whitespace collapsed) and read back through information_schema. Replacing
 * a chosen view, or creating comparison views, can fail with a metadata lock
 * timeout a given number of times.
 *
 * `installed` is shared on purpose: passing one run's map to the next lets the
 * second run see the first run's views.
 */
function fakeDatabase({
  installed = new Map<string, FakeView>(),
  lockedViews = new Map<string, number>(),
  lockedCandidates = 0,
  failCandidateFor,
  failDrops = false
}: {
  installed?: Map<string, FakeView>;
  lockedViews?: Map<string, number>;
  lockedCandidates?: number;
  failCandidateFor?: string;
  failDrops?: boolean;
} = {}) {
  const statements: string[] = [];
  let candidateLocks = lockedCandidates;
  const normalize = (definition: string) => definition.replace(/\s+/g, ' ');
  const asView = (definition: string): FakeView => ({
    view_definition: normalize(definition),
    security_type: 'INVOKER',
    character_set_client: 'utf8mb4',
    collation_connection: 'utf8mb4_0900_ai_ci'
  });
  const execute = jest.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes('information_schema.views'))
      return Array.from(installed.keys())
        .filter((name) => name.startsWith('lgf_candidate_'))
        .map((name) => ({ name }));
    let match =
      /^create or replace sql security invoker view `([^`]+)` as ([\s\S]+)$/.exec(
        sql
      );
    if (match) {
      const remaining = lockedViews.get(match[1]) ?? 0;
      if (remaining > 0) {
        lockedViews.set(match[1], remaining - 1);
        throw lockTimeout();
      }
      installed.set(match[1], asView(match[2]));
      return [];
    }
    match = /^create sql security invoker view `([^`]+)` as ([\s\S]+)$/.exec(
      sql
    );
    if (match) {
      if (candidateLocks > 0) {
        candidateLocks--;
        throw lockTimeout();
      }
      if (failCandidateFor && normalize(match[2]) === failCandidateFor)
        throw new Error('candidate failed');
      installed.set(match[1], asView(match[2]));
      return [];
    }
    match = /^drop view if exists `([^`]+)`$/.exec(sql);
    if (match) {
      if (failDrops) throw Object.assign(new Error('drop'), { code: 'ER_X' });
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

const replacements = (statements: string[], view?: string) =>
  statements.filter(
    (sql) =>
      sql.startsWith('create or replace') &&
      (view === undefined || sql.includes(`\`${view}\``))
  );
const expectSessionRestored = (statements: string[]) =>
  expect(statements.at(-1)).toBe('set session lock_wait_timeout=:timeout');
const noSleep = jest.fn(async (_ms: number) => undefined);

async function installedOnce() {
  const first = fakeDatabase();
  await installLegacyCompetitionGetFacade(first.db, { sleep: noSleep });
  return first.installed;
}

describe('installLegacyCompetitionGetFacade', () => {
  beforeEach(() => noSleep.mockClear());

  it('tries each DDL statement once per retry delay plus once', () => {
    expect(FACADE_DDL_ATTEMPTS).toBe(FACADE_RETRY_DELAYS_MS.length + 1);
  });

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
    const installed = await installedOnce();
    const second = fakeDatabase({ installed });
    const result = await installLegacyCompetitionGetFacade(second.db, {
      sleep: noSleep
    });
    expect(result.replaced).toEqual([]);
    expect(result.unchanged).toHaveLength(LEGACY_GET_SOURCE_TABLES.length);
    expect(replacements(second.statements)).toEqual([]);
    expect(
      Array.from(installed.keys()).filter((name) =>
        name.startsWith('lgf_candidate_')
      )
    ).toEqual([]);
  });

  it('replaces only the view whose definition changed', async () => {
    const installed = await installedOnce();
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

  it('sweeps comparison views left by an aborted run', async () => {
    const installed = await installedOnce();
    installed.set('lgf_candidate_0123456789ab', {
      ...installed.get(legacyGetView(LEGACY_GET_SOURCE_TABLES[0]))!
    });
    const second = fakeDatabase({ installed });
    await installLegacyCompetitionGetFacade(second.db, { sleep: noSleep });
    expect(installed.has('lgf_candidate_0123456789ab')).toBe(false);
  });

  it('waits at most the short lock timeout and restores the session', async () => {
    const { db, statements } = fakeDatabase();
    await installLegacyCompetitionGetFacade(db, { sleep: noSleep });
    expect(db.execute).toHaveBeenCalledWith(
      'set session lock_wait_timeout=:lockWaitSeconds',
      { lockWaitSeconds: FACADE_LOCK_WAIT_SECONDS },
      expect.anything()
    );
    expect(db.execute).toHaveBeenLastCalledWith(
      'set session lock_wait_timeout=:timeout',
      { timeout: 31536000 },
      expect.anything()
    );
    expectSessionRestored(statements);
  });

  it('retries a locked view with backoff and then replaces it', async () => {
    const view = legacyGetView(LEGACY_GET_SOURCE_TABLES[0]);
    const { db, statements } = fakeDatabase({
      lockedViews: new Map([[view, FACADE_DDL_ATTEMPTS - 1]])
    });
    const result = await installLegacyCompetitionGetFacade(db, {
      sleep: noSleep
    });
    expect(result.replaced).toContain(view);
    expect(replacements(statements, view)).toHaveLength(FACADE_DDL_ATTEMPTS);
    expect(noSleep.mock.calls.map(([ms]) => ms)).toEqual([
      ...FACADE_RETRY_DELAYS_MS
    ]);
  });

  it('fails cleanly when a view stays locked, still restoring the session', async () => {
    const view = legacyGetView(LEGACY_GET_SOURCE_TABLES[1]);
    const { db, statements } = fakeDatabase({
      lockedViews: new Map([[view, 99]])
    });
    await expect(
      installLegacyCompetitionGetFacade(db, { sleep: noSleep })
    ).rejects.toThrow(
      `Facade view ${view} stayed locked after ${FACADE_DDL_ATTEMPTS} attempts`
    );
    expect(replacements(statements, view)).toHaveLength(FACADE_DDL_ATTEMPTS);
    expectSessionRestored(statements);
  });

  it('retries a locked comparison view under the same bounded wait', async () => {
    const installed = await installedOnce();
    const second = fakeDatabase({
      installed,
      lockedCandidates: FACADE_DDL_ATTEMPTS - 1
    });
    const result = await installLegacyCompetitionGetFacade(second.db, {
      sleep: noSleep
    });
    expect(result.replaced).toEqual([]);
    expect(noSleep).toHaveBeenCalledTimes(FACADE_DDL_ATTEMPTS - 1);
  });

  it('surfaces a comparison failure mid-run and restores the session', async () => {
    const installed = await installedOnce();
    const failing = legacyGetView(LEGACY_GET_SOURCE_TABLES[3]);
    const second = fakeDatabase({
      installed,
      failCandidateFor: installed.get(failing)!.view_definition
    });
    await expect(
      installLegacyCompetitionGetFacade(second.db, { sleep: noSleep })
    ).rejects.toThrow('candidate failed');
    expectSessionRestored(second.statements);
  });

  it('never lets a failed comparison-view drop mask the result', async () => {
    const installed = await installedOnce();
    const second = fakeDatabase({ installed, failDrops: true });
    const result = await installLegacyCompetitionGetFacade(second.db, {
      sleep: noSleep
    });
    expect(result.unchanged).toHaveLength(LEGACY_GET_SOURCE_TABLES.length);
  });

  it('does not retry other errors', async () => {
    const { db, execute } = fakeDatabase();
    const failure = new Error('syntax');
    execute.mockImplementationOnce(async () => []); // lock timeout setting
    execute.mockImplementationOnce(async () => []); // candidate sweep
    execute.mockImplementationOnce(async () => {
      throw failure;
    });
    await expect(
      installLegacyCompetitionGetFacade(db, { sleep: noSleep })
    ).rejects.toBe(failure);
    expect(noSleep).not.toHaveBeenCalled();
  });
});
