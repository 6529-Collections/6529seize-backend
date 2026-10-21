import {
  COMPETITION_SCORE_HISTORY_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { SqlExecutor } from '@/sql-executor';
import { NATIVE_SCORE_SEQUENCE_BASE } from './competition-score-history';
import { mirrorNativeLegacyVote } from './legacy-competition-mirror';

const params = {
  competitionId: 'competition',
  entryId: 'entry',
  voterProfileId: 'voter',
  previousVote: 5,
  value: 7,
  occurredAt: 1000
};
const ctx = { connection: { connection: {} } } as RequestContext;

function database(
  aggregateId: unknown,
  voterId: unknown = 73,
  normalized = false
) {
  const execute = jest.fn(
    async (sql: string, _params?: Record<string, unknown>) => {
      if (sql.startsWith(`insert into ${DROP_REAL_VOTE_IN_TIME_TABLE} `))
        return normalized ? [0, 1, aggregateId] : { insertId: aggregateId };
      if (sql.startsWith(`insert into ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} `))
        return normalized ? [0, 1, voterId] : { insertId: voterId };
      if (sql.includes('last_insert_id'))
        throw new Error('Connection-level insert state must not be queried');
      return { affectedRows: 1 };
    }
  );
  const db = {
    execute,
    oneOrNull: jest
      .fn()
      .mockResolvedValueOnce({
        wave_id: 'wave',
        drop_id: 'drop',
        aggregate_value: 7
      })
      .mockResolvedValueOnce({ storage_mode: 'NATIVE', legacy_wave_id: 'wave' })
  } as unknown as SqlExecutor;
  return { db, execute };
}

describe('Preparatory native score mirrors', () => {
  it.each([false, true])(
    'uses each physical INSERT ID for its independent stream (normalized=%s)',
    async (normalized) => {
      const { db, execute } = database(41, '73', normalized);
      await mirrorNativeLegacyVote(db, params, ctx, 11);
      const scores = execute.mock.calls.filter(([sql]) =>
        sql.includes(`insert into ${COMPETITION_SCORE_HISTORY_TABLE}`)
      );
      expect(scores).toHaveLength(2);
      expect(scores[0][1]).toEqual(
        expect.objectContaining({ sequence: 41, mutationSequence: 11 })
      );
      expect(scores[1][1]).toEqual(
        expect.objectContaining({ sequence: 73, mutationSequence: 11 })
      );
      expect(
        execute.mock.calls.some(([sql]) => sql.includes('last_insert_id'))
      ).toBe(false);
    }
  );

  it.each([
    0,
    -1,
    null,
    undefined,
    'not-an-id',
    NATIVE_SCORE_SEQUENCE_BASE,
    NATIVE_SCORE_SEQUENCE_BASE + 1,
    Number.MAX_SAFE_INTEGER + 1
  ])(
    'rejects an invalid physical source ID %s before copying a score observation',
    async (id) => {
      const { db, execute } = database(id);
      await expect(mirrorNativeLegacyVote(db, params, ctx, 11)).rejects.toThrow(
        'Retained score history requires a safe source sequence'
      );
      expect(
        execute.mock.calls.some(([sql]) =>
          sql.includes(`insert into ${COMPETITION_SCORE_HISTORY_TABLE}`)
        )
      ).toBe(false);
    }
  );
});
