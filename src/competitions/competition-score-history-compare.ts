import { createHash } from 'node:crypto';
import { sqlExecutor } from '@/sql-executor';
import { competitionScoreResetRepository } from '@/competitions/competition-score-reset.repository';
import { competitionScoreHistorySql } from '@/competitions/competition-score-history-query';
import { NATIVE_SCORE_SEQUENCE_BASE } from './competition-score-history';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Read-only operator comparison in one snapshot; never returns vote contents. */
export async function compareCompetitionScoreHistory(
  competitionId: unknown,
  explain: boolean
) {
  if (
    typeof competitionId !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(competitionId)
  ) {
    throw new Error('compare requires a competition_id UUID');
  }
  if (!(await competitionScoreResetRepository.progress({})).backfill_complete) {
    throw new Error('Complete the reset backfill before comparing readers');
  }
  return sqlExecutor.executeNativeQueriesInTransaction(
    async (connection) => {
      const results: {
        mode: string;
        rows: number;
        ms: number;
        digest: string;
        plan?: unknown;
      }[] = [];
      let reference: { kind: string }[] = [];
      for (const mode of ['legacy-reset', 'projected', 'aggregate']) {
        const query = competitionScoreHistorySql(
          mode !== 'legacy-reset',
          mode === 'aggregate'
        );
        const params = { competitionId, base: NATIVE_SCORE_SEQUENCE_BASE };
        const started = Date.now();
        const rows = await sqlExecutor.execute<{ kind: string }>(
          query,
          params,
          {
            wrappedConnection: connection
          }
        );
        const ms = Date.now() - started;
        if (mode === 'legacy-reset') reference = rows;
        const expected =
          mode === 'aggregate'
            ? reference.filter((row) => row.kind === 'AGGREGATE')
            : reference;
        const hash = digest(rows);
        if (hash !== digest(expected))
          throw new Error('Score history readers differ');
        const plan = explain
          ? await sqlExecutor.execute(`explain analyze ${query}`, params, {
              wrappedConnection: connection
            })
          : undefined;
        results.push({
          mode,
          rows: rows.length,
          ms,
          digest: hash,
          ...(explain ? { plan } : {})
        });
      }
      return { equal: true, results };
    },
    { isolationLevel: 'REPEATABLE READ' }
  );
}
