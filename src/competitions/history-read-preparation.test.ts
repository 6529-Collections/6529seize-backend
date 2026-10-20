import {
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  installLegacyCompetitionGetFacade,
  legacyGetView,
  withLegacyCompetitionGetFacade
} from './legacy-competition-get-facade';

describeWithSeed('rolling historical GET preparation', [], () => {
  it.each([DROP_REAL_VOTE_IN_TIME_TABLE, DROP_REAL_VOTER_VOTE_IN_TIME_TABLE])(
    'keeps old observations before transfer and follows the switched view without another API deployment: %s',
    async (table) => {
      const voter =
        table === DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
          ? { voter_id: 'voter' }
          : {};
      const row = {
        id: 42,
        wave_id: 'history-wave',
        drop_id: 'history-drop',
        timestamp: 1000,
        vote: 7,
        ...voter
      };
      await sqlExecutor.bulkInsert(table, [row], Object.keys(row));
      const query = `select id,vote from ${table} where wave_id=:waveId`;
      const normalize = (
        rows: { id: number | string; vote: number | string }[]
      ) =>
        rows.map((value) => ({
          id: Number(value.id),
          vote: Number(value.vote)
        }));
      const read = async () =>
        normalize(
          await withLegacyCompetitionGetFacade(() =>
            sqlExecutor.execute<{ id: number | string; vote: number | string }>(
              query,
              { waveId: row.wave_id }
            )
          )
        );
      expect(await read()).toEqual([{ id: 42, vote: 7 }]);
      try {
        // The final retirement installs native projections under these exact
        // names. Its old API process must immediately use the new authority.
        await sqlExecutor.execute(
          `create or replace sql security invoker view ${legacyGetView(table)} as
           select 900 as id,'history-wave' as wave_id,11 as vote`
        );
        expect(await read()).toEqual([{ id: 900, vote: 11 }]);
        expect(
          normalize(
            await sqlExecutor.execute<{
              id: number | string;
              vote: number | string;
            }>(query, { waveId: row.wave_id })
          )
        ).toEqual([{ id: 42, vote: 7 }]);
      } finally {
        await installLegacyCompetitionGetFacade(sqlExecutor);
      }
    }
  );
});
