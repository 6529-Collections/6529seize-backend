import { randomUUID } from 'node:crypto';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { withLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import {
  SQL_IN_LIST_CHUNK_BYTES,
  sqlInListBytes
} from '@/db/sql-in-list-chunks';
import { IdentitiesDb } from '@/identities/identities.db';
import { SqlExecutor } from '@/sql-executor';

type Call = { sql: string; profileIds: string[]; connection: unknown };

/** Answers each statement with one drop per listed profile. */
function fakeRepo() {
  const calls: Call[] = [];
  let running = 0;
  let maxRunning = 0;
  const execute = jest.fn(
    async (
      sql: string,
      params: { profileIds: string[] },
      options?: { wrappedConnection?: unknown }
    ) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      calls.push({
        sql,
        profileIds: params.profileIds,
        connection: options?.wrappedConnection
      });
      await new Promise((resolve) => setImmediate(resolve));
      running--;
      return params.profileIds.map((profile_id) => ({
        profile_id,
        drop_id: `drop-of-${profile_id}`
      }));
    }
  );
  const repo = new IdentitiesDb(() => ({ execute }) as unknown as SqlExecutor);
  return { repo, calls, maxRunning: () => maxRunning };
}

const inlinedBytes = (call: Call) =>
  sqlInListBytes(call.profileIds) * (call.sql.split(':profileIds').length - 1);

describe('main stage drop ids for many profiles', () => {
  const profiles = Array.from({ length: 1000 }, () => randomUUID());

  beforeEach(() => {
    jest
      .spyOn(competitionAnonymityService, 'hiddenDropIds')
      .mockResolvedValue(new Set());
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['getActiveMainStageDropIds', 'getMainStageWinnerDropIds'] as const)(
    '%s keeps every statement under the inlined-list budget and covers every profile once',
    async (method) => {
      const { repo, calls } = fakeRepo();
      const result = await repo[method](profiles, {});
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls)
        expect(inlinedBytes(call)).toBeLessThanOrEqual(SQL_IN_LIST_CHUNK_BYTES);
      expect(calls.flatMap((call) => call.profileIds).sort()).toEqual(
        [...profiles].sort()
      );
      expect(Object.keys(result)).toHaveLength(profiles.length);
      expect(result[profiles[0]]).toEqual([`drop-of-${profiles[0]}`]);
    }
  );

  it('sizes chunks for the legacy facade, which inlines the list more often', async () => {
    const { repo, calls } = fakeRepo();
    await withLegacyCompetitionGetFacade(() =>
      repo.getMainStageWinnerDropIds(profiles, {})
    );
    expect(calls[0].sql.split(':profileIds').length - 1).toBe(4);
    for (const call of calls)
      expect(inlinedBytes(call)).toBeLessThanOrEqual(SQL_IN_LIST_CHUNK_BYTES);
  });

  it('runs chunks one at a time on a caller-owned connection', async () => {
    const { repo, calls, maxRunning } = fakeRepo();
    const connection = { connection: {} };
    await repo.getActiveMainStageDropIds(profiles, {
      connection: connection as never
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(maxRunning()).toBe(1);
    expect(calls.every((call) => call.connection === connection)).toBe(true);
  });

  it('keeps a short list to one statement', async () => {
    const { repo, calls } = fakeRepo();
    await repo.getActiveMainStageDropIds(profiles.slice(0, 20), {});
    expect(calls).toHaveLength(1);
  });
});
