import { compareCompetitionScoreHistory } from '@/competitions/competition-score-history-compare';
import * as tables from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { legacyCompetitionId } from './competition-id';
import { nativeScoreSequence } from './competition-score-history';
import { CompetitionScoreResetRepository } from '@/competitions/competition-score-reset.repository';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { RequestContext } from '@/request.context';

const wave = aWave(
  {},
  { id: 'reset-history-wave', name: 'Reset history', serial_no: 1 }
);
const competitionId = legacyCompetitionId(wave.id);
const active = 'active-entry';

/** The original production query, independent of the new projection SQL. */
const original = `with score_resets as (
  select json_unquote(json_extract(event,'$.competition_entry_id')) as entry_id,event,
    row_number() over (
      partition by json_unquote(json_extract(event,'$.competition_entry_id'))
      order by cast(json_unquote(json_extract(event,'$.data.content_revision')) as unsigned) desc,created_at desc,id desc
    ) as reset_order
  from competition_outbox where competition_id=:competitionId
    and json_unquote(json_extract(event,'$.event_type'))='COMPETITION_ENTRY_UPDATED'
    and json_contains_path(event,'all','$.data.vote_history_sequence','$.data.aggregate_history_sequence','$.data.voter_history_sequence')
)
select h.entry_id,h.voter_profile_id,if(h.kind='VOTER',h.value,0) as value,
  if(h.kind='AGGREGATE',h.value,0) as aggregate_value,h.occurred_at,h.sequence,h.kind,
  if(h.mutation_sequence is null,h.sequence,4503599627370496+h.mutation_sequence) as order_sequence
from competition_score_history h join competition_entries e
  on e.id=h.entry_id and e.competition_id=h.competition_id
left join score_resets r on r.entry_id=h.entry_id and r.reset_order=1
where h.competition_id=:competitionId and e.status='ACTIVE' and
  (r.entry_id is null or (h.mutation_sequence is not null and h.mutation_sequence>
    cast(json_unquote(json_extract(r.event,'$.data.vote_history_sequence')) as unsigned))
  or (h.mutation_sequence is null and h.sequence>
    cast(json_unquote(json_extract(r.event,if(h.kind='AGGREGATE','$.data.aggregate_history_sequence','$.data.voter_history_sequence'))) as unsigned)))
order by h.occurred_at,order_sequence,h.kind`;

describeWithSeed(
  'score history projection equivalence and cutover',
  [withWaves([wave])],
  () => {
    let resets: CompetitionScoreResetRepository;
    let runtime: NativeCompetitionRuntimeRepository;

    async function event(
      revision: number,
      cutoffs = [20, 4, 8],
      occurredAt = 1000,
      ctx?: RequestContext
    ) {
      const enqueue = (tx: RequestContext) =>
        runtime.enqueueEvent(
          {
            key: `reset:${revision}:${occurredAt}`,
            event_type: 'COMPETITION_ENTRY_UPDATED',
            competition_id: competitionId,
            wave_id: wave.id,
            competition_entry_id: active,
            occurred_at: occurredAt,
            data: {
              content_revision: revision,
              vote_history_sequence: cutoffs[0],
              aggregate_history_sequence: cutoffs[1],
              voter_history_sequence: cutoffs[2]
            }
          },
          tx
        );
      return ctx
        ? enqueue(ctx)
        : sqlExecutor.executeNativeQueriesInTransaction((connection) =>
            enqueue({ connection })
          );
    }

    async function finishBackfill() {
      while (await resets.backfillNext()) {
        /* resume bounded transactions */
      }
    }

    async function expected() {
      return sqlExecutor.execute<{ kind: string }>(original, { competitionId });
    }

    beforeEach(async () => {
      resets = new CompetitionScoreResetRepository(() => sqlExecutor);
      runtime = new NativeCompetitionRuntimeRepository(() => sqlExecutor);
      await seedNativeOriginalPrimaryFixture(wave);
      for (const [entryId, status] of [
        [active, 'ACTIVE'],
        ['winner-entry', 'WINNER'],
        ['no-reset', 'ACTIVE']
      ]) {
        await sqlExecutor.execute(
          `insert into ${tables.COMPETITION_ENTRIES_TABLE}
        (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at)
        values (:entryId,:competitionId,:waveId,:entryId,'artist',:status,1,0)`,
          { entryId, status, competitionId, waveId: wave.id }
        );
      }
      for (const entryId of [active, 'winner-entry', 'no-reset', null]) {
        for (const [kind, sequence, mutation] of [
          ['AGGREGATE', 1, null],
          ['AGGREGATE', 4, null],
          ['AGGREGATE', 9, null],
          ['VOTER', 2, null],
          ['VOTER', 8, null],
          ['VOTER', 12, null],
          ['AGGREGATE', nativeScoreSequence(20), 20],
          ['VOTER', nativeScoreSequence(20), 20],
          ['AGGREGATE', nativeScoreSequence(21), 21],
          ['VOTER', nativeScoreSequence(21), 21]
        ]) {
          // Source sequences are unique per stream, including unmatched history.
          const offset =
            [active, 'winner-entry', 'no-reset', null].indexOf(entryId) * 100;
          await sqlExecutor.execute(
            `insert into ${tables.COMPETITION_SCORE_HISTORY_TABLE}
          (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at,mutation_sequence)
          values (:competitionId,:kind,:sequence,:entryId,'drop','voter',17,1000,:mutation)`,
            {
              competitionId,
              kind,
              sequence: Number(sequence) + offset,
              entryId,
              mutation
            }
          );
        }
      }
    });

    it('matches the old query before and after backfill, and filters totals in SQL', async () => {
      await event(3);
      await event(1, [0, 0, 0], 2000); // Later time must not beat a newer revision.
      await sqlExecutor.execute(
        `delete from ${tables.COMPETITION_SCORE_RESETS_TABLE}`
      );
      const reference = await expected();
      expect(reference.length).toBeGreaterThan(0);
      expect(await runtime.listHistory(competitionId, {})).toEqual(reference);
      await expect(resets.setReadsEnabled(true)).rejects.toThrow(
        'backfill must be complete'
      );
      await finishBackfill();
      await resets.setReadsEnabled(true);
      expect(await runtime.listHistory(competitionId, {})).toEqual(reference);
      expect(await runtime.listAggregateHistory(competitionId, {})).toEqual(
        reference.filter((row) => row.kind === 'AGGREGATE')
      );
      const comparison = await compareCompetitionScoreHistory(
        competitionId,
        true
      );
      expect(comparison.equal).toBe(true);
      expect(comparison.results.map((result) => result.rows)).toEqual([
        reference.length,
        reference.length,
        reference.filter((row) => row.kind === 'AGGREGATE').length
      ]);
      expect(JSON.stringify(comparison.results[2].plan)).not.toContain(
        'competition_outbox'
      );
      await resets.setReadsEnabled(false);
      expect(await runtime.listHistory(competitionId, {})).toEqual(reference);
    });

    it('preserves same-millisecond votes and rolls the event and projection back together', async () => {
      await event(3);
      await finishBackfill();
      await resets.setReadsEnabled(true);
      const reference = await expected();
      expect(
        (await runtime.listHistory(competitionId, {})).filter(
          (row) => row.entry_id === active
        )
      ).toHaveLength(4);
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await event(4, [21, 9, 12], 1000, { connection });
          throw new Error('rollback edit');
        })
      ).rejects.toThrow('rollback edit');
      expect(await runtime.listHistory(competitionId, {})).toEqual(reference);
      await event(4, [21, 9, 12]);
      expect(await runtime.listHistory(competitionId, {})).toEqual(
        await expected()
      );
      expect(
        (await runtime.listHistory(competitionId, {})).filter(
          (row) => row.entry_id === active
        )
      ).toEqual([]);
    });

    it('keeps newer live resets through resumed backfill and idempotent retries', async () => {
      const oldId = await event(1, [0, 0, 0], 2000);
      await event(3);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        resets.projectEvent(oldId, { connection })
      );
      expect(await resets.backfillNext()).toBe(true);
      expect((await resets.progress({})).backfill_complete).toBe(false);
      await event(4, [21, 9, 12]);
      await finishBackfill();
      await resets.setReadsEnabled(true);
      expect(await runtime.listHistory(competitionId, {})).toEqual(
        await expected()
      );
      const [stored] = await sqlExecutor.execute<{ content_revision: number }>(
        `select content_revision from ${tables.COMPETITION_SCORE_RESETS_TABLE} where entry_id=:entryId`,
        { entryId: active }
      );
      expect(Number(stored.content_revision)).toBe(4);
    });

    it('uses event id as the final tie breaker, and retries keep the stored event', async () => {
      await event(3);
      await event(3, [999, 999, 999]); // Same semantic event: persisted original wins.
      for (const suffix of ['2', '1']) {
        const eventId = `00000000-0000-0000-0000-00000000000${suffix}`;
        await sqlExecutor.execute(
          `insert into ${tables.COMPETITION_OUTBOX_TABLE}
        (id,competition_id,wave_id,semantic_key,event,created_at,next_attempt_at,attempts)
        values (:eventId,:competitionId,:waveId,:eventId,:payload,2000,2000,0)`,
          {
            eventId,
            competitionId,
            waveId: wave.id,
            payload: JSON.stringify({
              event_type: 'COMPETITION_ENTRY_UPDATED',
              competition_entry_id: active,
              data: {
                content_revision: 3,
                vote_history_sequence: 20,
                aggregate_history_sequence: 4,
                voter_history_sequence: suffix === '2' ? 12 : 8
              }
            })
          }
        );
        await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          resets.projectEvent(eventId, { connection })
        );
      }
      await finishBackfill();
      await resets.setReadsEnabled(true);
      expect(await runtime.listHistory(competitionId, {})).toEqual(
        await expected()
      );
      const [row] = await sqlExecutor.execute<{
        voter_history_sequence: number;
      }>(
        `select voter_history_sequence from ${tables.COMPETITION_SCORE_RESETS_TABLE} where entry_id=:active`,
        { active }
      );
      expect(Number(row.voter_history_sequence)).toBe(12);
      await resets.setReadsEnabled(false);
      expect((await resets.progress({})).backfill_complete).toBe(false);
      await expect(resets.setReadsEnabled(true)).rejects.toThrow(
        'backfill must be complete'
      );
    });

    it('preserves the original entry-id collation', async () => {
      await event(3);
      await sqlExecutor.execute(
        `update ${tables.COMPETITION_OUTBOX_TABLE}
      set event=json_set(event,'$.competition_entry_id',upper(:active))`,
        { active }
      );
      await sqlExecutor.execute(
        `delete from ${tables.COMPETITION_SCORE_RESETS_TABLE}`
      );
      const reference = await expected();
      expect(
        reference.filter(
          (row) => (row as { entry_id?: string }).entry_id === active
        )
      ).toHaveLength(4);
      await finishBackfill();
      await resets.setReadsEnabled(true);
      expect(await runtime.listHistory(competitionId, {})).toEqual(reference);
    });

    it('presentation-only edits never replace the latest real reset', async () => {
      await event(3);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        runtime.enqueueEvent(
          {
            key: 'preview:4',
            event_type: 'COMPETITION_ENTRY_UPDATED',
            competition_id: competitionId,
            wave_id: wave.id,
            competition_entry_id: active,
            occurred_at: 2000,
            data: { content_revision: 4 }
          },
          { connection }
        )
      );
      await finishBackfill();
      await resets.setReadsEnabled(true);
      expect(await runtime.listHistory(competitionId, {})).toEqual(
        await expected()
      );
    });

    it('a projection failure inside enqueueEvent rolls back the edit, outbox and projection', async () => {
      const originalProject =
        CompetitionScoreResetRepository.prototype.projectEvent;
      const failure = jest
        .spyOn(CompetitionScoreResetRepository.prototype, 'projectEvent')
        .mockImplementationOnce(async function (
          this: CompetitionScoreResetRepository,
          id: string,
          ctx: RequestContext
        ) {
          await originalProject.call(this, id, ctx);
          throw new Error('projection failed after writing');
        });
      try {
        await expect(
          sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
            await sqlExecutor.execute(
              `update ${tables.COMPETITION_ENTRIES_TABLE} set submitted_at=99 where id=:active`,
              { active },
              { wrappedConnection: connection }
            );
            await event(3, undefined, 1000, { connection });
          })
        ).rejects.toThrow('projection failed after writing');
        const [entry] = await sqlExecutor.execute<{ submitted_at: number }>(
          `select submitted_at from ${tables.COMPETITION_ENTRIES_TABLE} where id=:active`,
          { active }
        );
        expect(Number(entry.submitted_at)).toBe(0);
        for (const table of [
          tables.COMPETITION_OUTBOX_TABLE,
          tables.COMPETITION_SCORE_RESETS_TABLE
        ]) {
          const [row] = await sqlExecutor.execute<{ n: number }>(
            `select count(*) as n from ${table}`
          );
          expect(Number(row.n)).toBe(0);
        }
      } finally {
        failure.mockRestore();
      }
    });
  }
);
