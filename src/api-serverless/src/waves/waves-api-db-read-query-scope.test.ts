import {
  isLegacyCompetitionGetFacadeScope,
  legacyCompetitionGetSql,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { IdentitiesDb } from '@/identities/identities.db';
import { SqlExecutor } from '@/sql-executor';
import { WavesApiDb } from './waves.api.db';

describe('hot GET query sources', () => {
  it('avoids wave config projections while preserving badge drop projection and caller scope', async () => {
    const queries: string[] = [];
    const execute = jest.fn(async (sql: string) => {
      await Promise.resolve();
      queries.push(legacyCompetitionGetSql(sql));
      return [];
    });
    const repo = new IdentitiesDb(
      () => ({ execute }) as unknown as SqlExecutor
    );

    await withLegacyCompetitionGetFacade(async () => {
      await repo.getActiveMainStageDropIds(['artist'], {});
      await repo.getMainStageWinnerDropIds(['artist'], {});
      expect(isLegacyCompetitionGetFacadeScope()).toBe(true);
      expect(legacyCompetitionGetSql('select * from waves')).toContain(
        'legacy_get_waves'
      );
    });
    expect(queries).toHaveLength(2);
    for (const sql of queries) {
      expect(sql).toContain('from legacy_get_drops');
      expect(sql).toContain('join waves hub');
      expect(sql).not.toContain('legacy_get_waves');
    }

    queries.length = 0;
    await repo.getMainStageWinnerDropIds(['artist'], {});
    expect(queries[0]).toContain('from drops');
    expect(queries[0]).not.toContain('legacy_get_');
  });

  it('keeps unread aggregates on base sources and retains snapshot writer and transaction options', async () => {
    const queries: string[] = [];
    const options: (DbQueryOptions | undefined)[] = [];
    const execute = jest.fn(
      async (sql: string, _params: unknown, opts?: DbQueryOptions) => {
        await Promise.resolve();
        queries.push(legacyCompetitionGetSql(sql));
        options.push(opts);
        return [];
      }
    );
    const repo = new WavesApiDb(() => ({ execute }) as unknown as SqlExecutor);
    const connection = { connection: {} };
    await withLegacyCompetitionGetFacade(async () => {
      await repo.findDmUnreadConversationStates(
        { identityId: 'scope-reader', eligibleGroups: ['visible'] },
        { connection },
        DbPoolName.WRITE
      );
      await repo.findIdentityUnreadDropsSummaryByWaveId(
        { identityId: 'scope-reader', waveIds: ['scope-wave'] },
        { connection }
      );
      await repo.findFollowedSubwaveOverviewContextsByParentWaveId(
        {
          identityId: 'scope-reader',
          parentWaveIds: ['scope-parent'],
          eligibleGroups: ['visible']
        },
        { connection }
      );
      expect(isLegacyCompetitionGetFacadeScope()).toBe(true);
    });
    expect(queries).toHaveLength(4);
    for (const sql of queries) {
      expect(sql).not.toContain('legacy_get_');
      expect(sql).not.toContain('USE INDEX');
    }
    expect(options[0]).toEqual({
      wrappedConnection: connection,
      forcePool: DbPoolName.WRITE
    });
    expect(
      options.every((option) => option?.wrappedConnection === connection)
    ).toBe(true);
  });
});
