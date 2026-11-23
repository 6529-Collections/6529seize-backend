import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { competitionVoteDelta } from '@/competitions/competition-credit.service';
import { CompetitionExecutionRouter } from '@/competitions/competition-execution.router';
import { installLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import { NativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { MetricRollupHourMetric } from '@/entities/IMetricRollupHour';
import { WaveType } from '@/entities/IWave';
import { metricsDb } from '@/metrics/MetricsDb';
import { metricsRecorder } from '@/metrics/MetricsRecorder';
import {
  RecountOptions,
  recountMetricRollupHour
} from '@/metrics/metrics-rebuild';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { rollupRows } from '@/tests/fixtures/metric-rollup-hour.fixture';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

/**
 * The recount against live rows. What it covers: drops created through the
 * drop use case (chat drops, and a legacy participatory drop in the
 * MAIN_STAGE_WAVE_ID wave, for which the use case also writes an entry);
 * native Main Stage entries and vote changes recorded through
 * MetricsRecorder as the competition services call it; and a credit
 * reconciliation, which changes a vote with no rollup. All inside one hour,
 * the recount over the same rows gives the same DROP, DROPPER_DROP,
 * MAIN_STAGE_SUBMISSION and MAIN_STAGE_VOTE rows and the same active
 * identities. At an hour's edge they differ by design: live takes the hour
 * of its write, the recount the hour of the event.
 */

const chat = aWave(
  { type: WaveType.CHAT, chat_enabled: true },
  { id: 'live-chat', name: 'Live chat', serial_no: 1 }
);
const hub = aWave({}, { id: 'live-hub', name: 'Live hub', serial_no: 2 });
const legacyStage = aWave(
  { type: WaveType.RANK },
  { id: 'live-legacy-stage', name: 'Live legacy stage', serial_no: 3 }
);
const mainStage = {
  ...nativeOriginalPrimaryFixture(hub),
  id: '10000000-0000-4000-8000-0000000000a1'
};
const legacyCompetition = nativeOriginalPrimaryFixture(legacyStage);
const ENTRY_1 = '20000000-0000-4000-8000-0000000000a1';
const ENTRY_2 = '20000000-0000-4000-8000-0000000000a2';

const OPTIONS: RecountOptions = {
  mainStageWaveId: legacyStage.id,
  alertsWaveId: null,
  alertsBotProfileId: null,
  priorityAlertsWaveId: null
};

const COUNTERS = [
  MetricRollupHourMetric.DROP,
  MetricRollupHourMetric.DROPPER_DROP,
  MetricRollupHourMetric.MAIN_STAGE_SUBMISSION,
  MetricRollupHourMetric.MAIN_STAGE_VOTE
];

const FLAGS = [
  'MAIN_STAGE_WAVE_ID',
  'FEATURE_NATIVE_COMPETITION_WRITES',
  'FEATURE_NATIVE_COMPETITION_EXECUTION'
] as const;

function dropModel(
  authorId: string,
  content: string,
  waveId = chat.id,
  dropType = DropType.CHAT
): CreateOrUpdateDropModel {
  return {
    drop_id: null,
    wave_id: waveId,
    author_id: authorId,
    author_identity: authorId,
    drop_type: dropType,
    signature: null,
    title: dropType === DropType.PARTICIPATORY ? 'Entry' : null,
    reply_to: null,
    parts: [{ content, quoted_drop: null, media: [] }],
    metadata: [],
    mentioned_users: [],
    mentioned_waves: [],
    mentioned_groups: [],
    referenced_nfts: [],
    is_additional_action_promised: null
  };
}

async function post(model: CreateOrUpdateDropModel): Promise<string> {
  const created = await sqlExecutor.executeNativeQueriesInTransaction(
    (connection) =>
      createOrUpdateDrop.execute(model, false, {
        connection,
        prePublication: { trustedSystem: true }
      })
  );
  return created.drop_id;
}

/** The database's UTC clock, in epoch milliseconds. */
async function dbNow(): Promise<number> {
  const row = await sqlExecutor.oneOrNull<{ now: number | string }>(
    'select unix_timestamp(now(3)) * 1000 as now'
  );
  return Number(row?.now);
}

/** Waits out the last 30 s of an hour, so the events share one hour. */
async function awayFromAnHoursEdge(): Promise<void> {
  const now = await dbNow();
  const left = 3_600_000 - (now % 3_600_000);
  if (left < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, left + 1_000));
  }
}

const repository = new NativeCompetitionRuntimeRepository(() => sqlExecutor);
const runtime = new NativeCompetitionRuntimeService(
  repository,
  {} as never,
  new CompetitionExecutionRouter()
);

/** A native submission: its COMPETITION drop and entry, each with its rollups. */
async function submit(entryId: string, submitter: string) {
  const dropId = `drop-${entryId}`;
  await sqlExecutor.execute(
    `insert into ${DROPS_TABLE} (id, wave_id, author_id, created_at, parts_count, drop_type)
     values (:dropId, :waveId, :submitter, :now, 1, 'COMPETITION')`,
    { dropId, waveId: hub.id, submitter, now: Date.now() }
  );
  await metricsRecorder.recordCreatedDropAfterCommit({
    identityId: submitter,
    waveId: hub.id,
    dropType: DropType.COMPETITION
  });
  // As competition-entry.service does: the entry, then its rollup.
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    await sqlExecutor.execute(
      `insert into ${COMPETITION_ENTRIES_TABLE}
       (id, competition_id, wave_id, drop_id, submitter_id, status, config_version, submitted_at)
       values (:entryId, :competitionId, :waveId, :dropId, :submitter, 'ACTIVE', 1, :now)`,
      {
        entryId,
        competitionId: mainStage.id,
        waveId: hub.id,
        dropId,
        submitter,
        now: Date.now()
      },
      { wrappedConnection: connection }
    );
    await metricsRecorder.recordNativeCompetitionSubmission(
      { competitionId: mainStage.id },
      { connection }
    );
  });
}

/** As competition-voting.service does: the vote, its history row, then its rollup. */
async function vote(
  entryId: string,
  voter: string,
  previousVote: number,
  value: number
) {
  await repository.executeNativeQueriesInTransaction(async (connection) => {
    const ctx = { connection };
    const now = Date.now();
    await sqlExecutor.execute(
      `insert into ${COMPETITION_VOTES_TABLE}
       (id, competition_id, entry_id, voter_profile_id, value, credit_spent, created_at, updated_at)
       values (:id, :competitionId, :entryId, :voter, :value, abs(:value), :now, :now)
       on duplicate key update value = :value, credit_spent = abs(:value), updated_at = :now`,
      {
        id: randomUUID(),
        competitionId: mainStage.id,
        entryId,
        voter,
        value,
        now
      },
      { wrappedConnection: connection }
    );
    await repository.recordVoteChange(
      {
        competitionId: mainStage.id,
        entryId,
        voterProfileId: voter,
        previousVote,
        value,
        occurredAt: now
      },
      ctx
    );
    await metricsRecorder.recordNativeCompetitionVote(
      {
        competitionId: mainStage.id,
        voterId: voter,
        voteChange: competitionVoteDelta(previousVote, value)
      },
      ctx
    );
  });
}

/** The system cuts a voter's votes to their credit: no rollup. */
async function reconcile(voter: string, availableCredit: number) {
  await repository.executeNativeQueriesInTransaction(async (connection) => {
    const ctx = { connection };
    await repository.lockCompetition(mainStage.id, ctx);
    await runtime.reconcileVoterCredit(
      {
        competitionId: mainStage.id,
        voterProfileId: voter,
        availableCredit,
        creditScope: 'WAVE',
        occurredAt: Date.now()
      },
      ctx
    );
  });
}

describeWithSeed(
  'metric_rollup_hour recount against the live rows',
  [
    withWaves([chat, hub, legacyStage]),
    { table: COMPETITIONS_TABLE, rows: [mainStage, legacyCompetition] },
    {
      table: COMPETITION_CAPABILITIES_TABLE,
      rows: [mainStage, legacyCompetition].map((competition) => ({
        capability: 'MAIN_STAGE',
        competition_id: competition.id,
        wave_id: competition.wave_id,
        assigned_at: 0
      }))
    }
  ],
  () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(async () => {
      for (const flag of FLAGS) saved[flag] = process.env[flag];
      process.env.MAIN_STAGE_WAVE_ID = legacyStage.id;
      process.env.FEATURE_NATIVE_COMPETITION_WRITES = 'true';
      process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = 'true';
      await installLegacyCompetitionGetFacade(sqlExecutor);
    });
    afterEach(() => {
      for (const flag of FLAGS) {
        if (saved[flag] === undefined) delete process.env[flag];
        else process.env[flag] = saved[flag];
      }
    });

    it('gives the live counters back for events inside one hour', async () => {
      await awayFromAnHoursEdge();
      const startHour = Math.floor((await dbNow()) / 3_600_000);

      await post(dropModel('alice', 'first'));
      await post(dropModel('alice', 'second'));
      await post(dropModel('bob', 'third'));
      // A legacy Main Stage submission: live records it once, as a drop,
      // though the use case also writes an entry for it.
      const legacyDrop = await post(
        dropModel('gina', 'legacy', legacyStage.id, DropType.PARTICIPATORY)
      );
      await submit(ENTRY_1, 'carol');
      await submit(ENTRY_2, 'dave');
      await vote(ENTRY_1, 'erin', 0, 5);
      await vote(ENTRY_1, 'erin', 5, 2);
      await vote(ENTRY_2, 'frank', 0, -3);
      await reconcile('frank', 1);

      expect(Math.floor((await dbNow()) / 3_600_000)).toBe(startHour);
      const legacyEntry = await sqlExecutor.oneOrNull<{ n: number }>(
        `select count(*) as n from ${COMPETITION_ENTRIES_TABLE} where drop_id = :id`,
        { id: legacyDrop }
      );
      expect(Number(legacyEntry?.n)).toBe(1);
      const cut = await sqlExecutor.oneOrNull<{ n: number }>(
        `select count(*) as n from ${COMPETITION_VOTE_HISTORY_TABLE}
         where json_unquote(json_extract(contents, '$.reason')) = 'CREDIT_OVERSPENT'`
      );
      expect(Number(cut?.n)).toBe(1);

      const live = await rollupRows();
      await recountMetricRollupHour(sqlExecutor, OPTIONS);
      const recount = await rollupRows();

      for (const metric of COUNTERS) {
        expect({ metric, rows: recount[metric] }).toEqual({
          metric,
          rows: live[metric]
        });
      }
      expect(live[MetricRollupHourMetric.MAIN_STAGE_SUBMISSION]).toEqual([
        expect.objectContaining({ events: 3 })
      ]);
      expect(live[MetricRollupHourMetric.MAIN_STAGE_VOTE]).toEqual([
        expect.objectContaining({ scope: 'erin', events: 2, value: 2 }),
        expect.objectContaining({ scope: 'frank', events: 1, value: -3 })
      ]);
      // Active identities: within the hour the recount sees what live saw
      // here (the waves were created long before).
      const hour = live[MetricRollupHourMetric.DROP]![0].hour;
      const inHour = (rows: typeof live, metric: MetricRollupHourMetric) =>
        rows[metric]!.filter((row) => row.hour === hour).map(
          ({ scope, events }) => ({ scope, events })
        );
      expect(inHour(recount, MetricRollupHourMetric.ACTIVE_IDENTITY)).toEqual(
        inHour(live, MetricRollupHourMetric.ACTIVE_IDENTITY)
      );
    });

    it('puts an event at the end of an hour in that hour, where live put its write in the next', async () => {
      const eventAt = Date.parse('2026-01-05T10:59:59.900Z');
      await sqlExecutor.execute(
        `insert into ${DROPS_TABLE} (id, wave_id, author_id, created_at, parts_count, drop_type)
         values ('edge', :waveId, 'alice', :eventAt, 1, 'CHAT')`,
        { waveId: chat.id, eventAt }
      );
      // The live rollup, written after the commit, 300 ms later: the
      // database's clock is in the next hour by then.
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await sqlExecutor.execute(
            'set timestamp = :seconds',
            { seconds: (eventAt + 300) / 1000 },
            { wrappedConnection: connection }
          );
          await metricsDb.upsertMetricRollupHour(
            { metric: MetricRollupHourMetric.DROP, event_count: 1 },
            { connection }
          );
          await sqlExecutor.execute('set timestamp = default', undefined, {
            wrappedConnection: connection
          });
        }
      );
      expect((await rollupRows())[MetricRollupHourMetric.DROP]).toEqual([
        { hour: '2026-01-05 11:00:00', scope: 'global', events: 1, value: 1 }
      ]);

      await recountMetricRollupHour(sqlExecutor, OPTIONS);
      expect((await rollupRows())[MetricRollupHourMetric.DROP]).toEqual([
        { hour: '2026-01-05 10:00:00', scope: 'global', events: 1, value: 1 }
      ]);
    });
  }
);
