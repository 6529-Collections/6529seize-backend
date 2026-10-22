import {
  historicalCompetitionFixture,
  seedRetainedScoreFixture
} from '@/tests/fixtures/retained-competition.fixture';
import * as tables from '@/constants';
import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { dropsDb } from '@/drops/drops.db';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { WaveType } from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { competitionEntryDropHooks } from './competition-entry-drop-hooks';
import {
  legacyCompetitionEntryId,
  legacyCompetitionId
} from './competition-id';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { flooredWeightedNativeVote } from './native-competition-runtime.helpers';

const wave = aWave(
  { type: WaveType.RANK, time_lock_ms: 2000 },
  { id: 'presentation-history-hub', name: 'Presentation history', serial_no: 1 }
);
const id = legacyCompetitionId(wave.id);
const dropId = 'presentation-history-drop';
const entryId = legacyCompetitionEntryId(id, dropId);
const runtime = new NativeCompetitionRuntimeRepository(() => sqlExecutor);

describeWithSeed(
  'accepted original entry presentation updates',
  [
    withWaves([wave]),
    {
      table: tables.DROPS_TABLE,
      rows: [
        {
          id: dropId,
          wave_id: wave.id,
          author_id: 'artist',
          created_at: 0,
          drop_type: 'PARTICIPATORY',
          parts_count: 1,
          hide_link_preview: false
        }
      ]
    },
    {
      table: tables.DROPS_PARTS_TABLE,
      rows: [
        {
          drop_id: dropId,
          drop_part_id: 1,
          content: 'Retained submission',
          quoted_drop_id: null
        }
      ]
    },
    {
      table: tables.COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: entryId,
          competition_id: id,
          wave_id: wave.id,
          drop_id: dropId,
          submitter_id: 'artist',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 0
        }
      ]
    },
    {
      table: tables.COMPETITION_VOTES_TABLE,
      rows: [
        {
          id: 'allocated-vote',
          competition_id: id,
          entry_id: entryId,
          voter_profile_id: 'voter',
          value: 7,
          credit_spent: 7,
          created_at: 1000,
          updated_at: 2000
        }
      ]
    },
    {
      table: tables.COMPETITION_VOTE_HISTORY_TABLE,
      rows: [
        {
          sequence: 1,
          competition_id: id,
          entry_id: entryId,
          drop_id: dropId,
          submitter_id: 'artist',
          voter_profile_id: 'voter',
          value: 7,
          previous_value: 0,
          aggregate_value: 10,
          credit_delta: 7,
          occurred_at: 2000
        }
      ]
    },
    {
      table: tables.DROP_REAL_VOTE_IN_TIME_TABLE,
      rows: [
        { id: 2, drop_id: dropId, wave_id: wave.id, timestamp: 1000, vote: 10 }
      ]
    },
    {
      table: tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
      rows: [
        {
          id: 3,
          drop_id: dropId,
          wave_id: wave.id,
          voter_id: 'voter',
          timestamp: 1000,
          vote: 7
        }
      ]
    },
    {
      table: tables.COMPETITION_MIGRATIONS_TABLE,
      rows: [
        {
          competition_id: id,
          wave_id: wave.id,
          state: 'NATIVE',
          cohort: 'STANDARD',
          owner: 'fixture',
          stage: 'COMPLETE',
          completed_stages: [],
          exceptions: [],
          cutover_at: 2000,
          updated_at: 2000
        }
      ]
    }
  ],
  () => {
    beforeEach(async () => {
      await seedNativeOriginalPrimaryFixture(wave);
      await seedRetainedScoreFixture(sqlExecutor, id);
    });
    afterEach(() => jest.restoreAllMocks());

    it('keeps weighted history and allocations through preview edits, including after a same-millisecond full-content reset', async () => {
      const notify = jest.fn();
      const service = new DropCreationApiService(
        {
          findDropByIdOrThrow: async () => dropsDb.findDropById(dropId)
        } as never,
        dropsDb,
        {} as never,
        {} as never,
        {} as never,
        { notifyAboutDropUpdate: notify } as never,
        {} as never,
        {} as never,
        {} as never
      );
      const ctx = {
        authenticationContext: {
          getActingAsId: () => 'artist',
          isAuthenticatedAsProxy: () => false
        }
      } as RequestContext;
      const allocations = () =>
        sqlExecutor.execute(
          `SELECT * FROM ${tables.COMPETITION_VOTES_TABLE} WHERE competition_id=:id`,
          { id }
        );
      const weighted = async () =>
        flooredWeightedNativeVote(
          (await runtime.listHistory(id, {}))
            .filter((row) => row.kind === 'AGGREGATE')
            .map((row) => ({
              timestamp: row.occurred_at,
              vote: row.aggregate_value,
              sequence: row.order_sequence ?? row.sequence
            })),
          2000,
          2000
        );
      const history = await runtime.listHistory(id, {});
      const current = await allocations();
      const rating = await weighted();
      expect(rating).toBeGreaterThan(0);
      await service.toggleHideLinkPreview(
        { dropId, hideLinkPreview: true },
        ctx
      );
      expect(
        (await dropsDb.findDropById(dropId))?.hide_link_preview
      ).toBeTruthy();
      expect(await runtime.listHistory(id, {})).toEqual(history);
      expect(await allocations()).toEqual(current);
      expect(await weighted()).toBe(rating);

      jest.spyOn(Date, 'now').mockReturnValue(2000);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const tx = { connection };
          const edit = await competitionEntryDropHooks.prepareUpdate(
            { drop_id: dropId } as CreateOrUpdateDropModel,
            async () => {},
            tx
          );
          const drop = (await dropsDb.findDropById(dropId, connection))!;
          await competitionEntryDropHooks.recordUpdate(
            edit,
            { ...drop, title: 'Full-content edit' },
            'artist',
            tx
          );
          expect(await runtime.listHistory(id, tx)).toEqual([]);
          // This is the current-allocation reset performed by the full-content edit.
          await sqlExecutor.execute(
            `UPDATE ${tables.COMPETITION_VOTES_TABLE} SET value=11,credit_spent=11 WHERE competition_id=:id`,
            { id },
            { wrappedConnection: connection }
          );
          await runtime.recordVoteChange(
            {
              competitionId: id,
              entryId,
              voterProfileId: 'voter',
              previousVote: 0,
              value: 11,
              occurredAt: 2000
            },
            tx
          );
        }
      );
      const afterReset = await runtime.listHistory(id, {});
      expect(
        afterReset.map((row) => [
          row.kind,
          row.occurred_at,
          row.aggregate_value,
          row.value
        ])
      ).toEqual([
        ['AGGREGATE', 2000, 11, 0],
        ['VOTER', 2000, 0, 11]
      ]);
      const resetAllocations = await allocations();
      await service.toggleHideLinkPreview(
        { dropId, hideLinkPreview: false },
        ctx
      );
      expect(await runtime.listHistory(id, {})).toEqual(afterReset);
      expect(await allocations()).toEqual(resetAllocations);
      const events = await sqlExecutor.execute<{ event: string }>(
        `SELECT event FROM ${tables.COMPETITION_OUTBOX_TABLE} WHERE competition_id=:id AND JSON_UNQUOTE(JSON_EXTRACT(event,'$.event_type'))='COMPETITION_ENTRY_UPDATED' ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(event,'$.data.content_revision')) AS UNSIGNED)`,
        { id }
      );
      expect(events.map((row) => JSON.parse(row.event).data)).toEqual([
        { content_revision: 1 },
        {
          content_revision: 2,
          vote_history_sequence: 1,
          aggregate_history_sequence: 2,
          voter_history_sequence: 3
        },
        { content_revision: 3 }
      ]);
      expect(
        await sqlExecutor.execute(
          `SELECT version FROM ${tables.COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} WHERE entry_id=:entryId ORDER BY version`,
          { entryId }
        )
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      expect(notify).toHaveBeenCalledTimes(2);
    });
  },
  historicalCompetitionFixture
);
