import {
  isLegacyCompetitionGetFacadeScope,
  legacyCompetitionGetSql,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { SqlExecutor } from '@/sql-executor';
import { DropVotingDb } from './drop-voting.db';

/** Records what the API executor would send (db-api applies the rewriter). */
function apiLikeExecutor() {
  const sent: { raw: string; effective: string; inFacade: boolean }[] = [];
  const db = {
    execute: async (sql: string) => {
      sent.push({
        raw: sql,
        effective: legacyCompetitionGetSql(sql),
        inFacade: isLegacyCompetitionGetFacadeScope()
      });
      return [];
    }
  } as unknown as SqlExecutor;
  return { db, sent };
}

describe('drop rank statements under the API legacy facade', () => {
  it.each([
    ['realtime ranks', 'getParticipationDropsRealtimeRanks'],
    ['time-locked ranks', 'getTimeLockedDropsWeightedVotes']
  ] as const)(
    '%s reach MySQL unrewritten, reading the base drops table for candidates',
    async (_name, method) => {
      const { db, sent } = apiLikeExecutor();
      await withLegacyCompetitionGetFacade(() =>
        new DropVotingDb(() => db)[method](['drop-1'], {})
      );
      expect(sent).toHaveLength(1);
      const [{ raw, effective, inFacade }] = sent;
      expect(inFacade).toBe(false);
      expect(effective).toBe(raw);
      expect(raw).toMatch(/from\s+drops\s+pd/i);
      // The guard matters: inside the facade, that read becomes the view.
      expect(
        withLegacyCompetitionGetFacade(() => legacyCompetitionGetSql(raw))
      ).toMatch(/from\s+`legacy_get_drops`\s+pd/i);
    }
  );
});
