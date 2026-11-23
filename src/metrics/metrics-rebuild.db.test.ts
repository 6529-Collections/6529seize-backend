import 'reflect-metadata';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITIONS_TABLE,
  DELETED_DROPS_TABLE,
  DROP_BOOSTS_TABLE,
  DROP_REACTIONS_TABLE,
  DROPS_TABLE,
  HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  METRIC_ROLLUP_HOUR_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  TDH_GLOBAL_HISTORY_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { MetricRollupHourMetric } from '@/entities/IMetricRollupHour';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { WaveType } from '@/entities/IWave';
import {
  RecountOptions,
  recountMetricRollupHour
} from '@/metrics/metrics-rebuild';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  insertRow,
  rollupRows
} from '@/tests/fixtures/metric-rollup-hour.fixture';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

const at = (iso: string) => Date.parse(iso);
const HOUR_10 = '2026-01-05 10:00:00';
const HOUR_11 = '2026-01-05 11:00:00';
const HOUR_12 = '2026-01-05 12:00:00';
const HOUR_13 = '2026-01-05 13:00:00';

/** The system's alert waves and bot, as the environment names them. */
const OPTIONS: RecountOptions = {
  mainStageWaveId: null,
  alertsWaveId: 'alerts',
  alertsBotProfileId: 'alert-bot',
  priorityAlertsWaveId: 'priority'
};
const WITH_LEGACY_STAGE: RecountOptions = {
  ...OPTIONS,
  mainStageWaveId: 'legacy-stage'
};

const hub = aWave(
  { created_by: 'hub-creator', created_at: at('2026-01-05T10:20:00Z') },
  { id: 'metrics-hub', name: 'Metrics hub', serial_no: 1 }
);
// A members-only hub: its competition isn't designated Main Stage.
const privateHub = aWave(
  {
    created_by: 'hub-creator',
    created_at: at('2026-01-04T08:00:00Z'),
    visibility_group_id: 'members'
  },
  { id: 'metrics-private-hub', name: 'Private hub', serial_no: 2 }
);
// The legacy Main Stage wave, with its original-primary competition.
const legacyStage = aWave(
  {
    type: WaveType.RANK,
    created_by: 'stage-creator',
    created_at: at('2026-01-04T09:00:00Z')
  },
  { id: 'legacy-stage', name: 'Legacy stage', serial_no: 3 }
);
const mainStage = { ...nativeOriginalPrimaryFixture(hub), id: 'main-stage' };
const otherCompetition = {
  ...nativeOriginalPrimaryFixture(privateHub),
  id: 'other-competition'
};
const legacyCompetition = nativeOriginalPrimaryFixture(legacyStage);

const drop = (
  id: string,
  author: string,
  iso: string,
  waveId: string,
  dropType = DropType.CHAT,
  title: string | null = null
) => ({
  id,
  wave_id: waveId,
  author_id: author,
  created_at: at(iso),
  parts_count: 1,
  drop_type: dropType,
  title
});

const entry = (
  id: string,
  competition: { id: string; wave_id: string },
  dropId: string,
  iso: string
) => ({
  id,
  competition_id: competition.id,
  wave_id: competition.wave_id,
  drop_id: dropId,
  submitter_id: 'alice',
  status: 'ACTIVE',
  config_version: 1,
  submitted_at: at(iso)
});

const vote = (
  competitionId: string,
  voter: string,
  previous: number,
  value: number,
  iso: string,
  reason?: string
) => ({
  competition_id: competitionId,
  entry_id: 'entry-1',
  voter_profile_id: voter,
  value,
  previous_value: previous,
  aggregate_value: value,
  credit_delta: Math.abs(value) - Math.abs(previous),
  occurred_at: at(iso),
  contents: { oldVote: previous, newVote: value, ...(reason ? { reason } : {}) }
});

async function react(profileId: string, iso: string) {
  await sqlExecutor.execute(
    `insert into ${DROP_REACTIONS_TABLE} (profile_id, wave_id, drop_id, reaction, created_at)
     values (:profileId, :waveId, 'd1', ':+1:', from_unixtime(:seconds))`,
    { profileId, waveId: hub.id, seconds: at(iso) / 1000 }
  );
}

describeWithSeed(
  'metric_rollup_hour recount',
  [
    withWaves([hub, privateHub, legacyStage]),
    {
      table: COMPETITIONS_TABLE,
      rows: [mainStage, otherCompetition, legacyCompetition]
    },
    {
      table: COMPETITION_CAPABILITIES_TABLE,
      rows: [mainStage, otherCompetition, legacyCompetition].map(
        (competition) => ({
          capability: 'MAIN_STAGE',
          competition_id: competition.id,
          wave_id: competition.wave_id,
          assigned_at: 0
        })
      )
    },
    {
      table: DROPS_TABLE,
      rows: [
        drop('d1', 'alice', '2026-01-05T10:00:00.000Z', hub.id),
        drop('d2', 'alice', '2026-01-05T10:59:59.999Z', hub.id),
        drop('d3', 'bob', '2026-01-05T10:30:00Z', hub.id),
        drop('d4', 'bob', '2026-01-05T11:00:00Z', hub.id),
        // Native submissions: COMPETITION drops with their entries.
        drop(
          'c1',
          'alice',
          '2026-01-05T10:10:00Z',
          hub.id,
          DropType.COMPETITION
        ),
        drop('c2', 'bob', '2026-01-05T11:10:00Z', hub.id, DropType.COMPETITION),
        drop(
          'c3',
          'dave',
          '2026-01-05T10:10:00Z',
          privateHub.id,
          DropType.COMPETITION
        ),
        // A legacy Main Stage submission, a chat drop and a winner there.
        drop(
          'd5',
          'carol',
          '2026-01-05T12:15:00Z',
          legacyStage.id,
          DropType.PARTICIPATORY
        ),
        drop('d6', 'carol', '2026-01-05T11:20:00Z', legacyStage.id),
        drop(
          'd7',
          'carol',
          '2026-01-05T13:25:00Z',
          legacyStage.id,
          DropType.WINNER
        ),
        // Written by the system, without a rollup.
        drop('alert', 'alert-bot', '2026-01-05T10:15:00Z', 'alerts'),
        drop(
          'priority-alert',
          'ops',
          '2026-01-05T10:16:00Z',
          'priority',
          DropType.CHAT,
          'Priority Alert: disk full'
        ),
        // A person's drop in the priority alert wave counts.
        drop('in-priority', 'ops', '2026-01-05T10:17:00Z', 'priority')
      ]
    },
    {
      table: DELETED_DROPS_TABLE,
      rows: [
        {
          id: 'gone',
          wave_id: hub.id,
          author_id: 'dave',
          created_at: at('2026-01-05T10:45:00Z'),
          deleted_at: at('2026-01-05T12:00:00Z')
        },
        {
          id: 'gone-priority',
          wave_id: 'priority',
          author_id: 'ops',
          created_at: at('2026-01-05T10:18:00Z'),
          deleted_at: at('2026-01-05T12:00:00Z')
        }
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        entry('entry-1', mainStage, 'c1', '2026-01-05T10:10:00Z'),
        entry('entry-2', mainStage, 'c2', '2026-01-05T11:10:00Z'),
        entry('entry-3', otherCompetition, 'c3', '2026-01-05T10:10:00Z'),
        // The drop use case's entry for d5: no rollup of its own.
        entry('entry-4', legacyCompetition, 'd5', '2026-01-05T12:15:00Z')
      ]
    },
    {
      table: COMPETITION_VOTE_HISTORY_TABLE,
      rows: [
        vote(mainStage.id, 'erin', 0, 5, '2026-01-05T10:05:00Z'),
        vote(mainStage.id, 'erin', 5, 2, '2026-01-05T10:06:00Z'),
        vote(mainStage.id, 'frank', 0, -3, '2026-01-05T11:05:00Z'),
        // The system cutting a vote down to the voter's credit.
        vote(
          mainStage.id,
          'frank',
          -3,
          -1,
          '2026-01-05T11:06:00Z',
          'CREDIT_OVERSPENT'
        ),
        vote(otherCompetition.id, 'erin', 0, 7, '2026-01-05T10:07:00Z')
      ]
    },
    {
      table: DROP_BOOSTS_TABLE,
      rows: [
        {
          drop_id: 'd3',
          booster_id: 'grace',
          boosted_at: at('2026-01-05T10:40:00Z'),
          wave_id: hub.id
        }
      ]
    },
    {
      table: PROFILES_ACTIVITY_LOGS_TABLE,
      rows: [
        {
          id: 'log-user-edit',
          profile_id: 'heidi',
          target_id: 'alice',
          type: ProfileActivityLogType.RATING_EDIT,
          contents: { change_reason: 'USER_EDIT', new_rating: 5 },
          created_at: '2026-01-05 10:50:00'
        },
        {
          // Made by the system, not by the rater: not activity.
          id: 'log-lost-tdh',
          profile_id: 'ivan',
          target_id: 'alice',
          type: ProfileActivityLogType.RATING_EDIT,
          contents: { change_reason: 'LOST_TDH', new_rating: 0 },
          created_at: '2026-01-05 10:50:00'
        }
      ]
    }
  ],
  () => {
    beforeEach(async () => {
      await insertRow(IDENTITIES_TABLE, {
        consolidation_key: 'help-bot-key',
        profile_id: 'help-bot-profile',
        primary_address: '0x00000000000000000000000000000000000000b0',
        handle: 'help6529',
        normalised_handle: 'help6529'
      });
      await react('judy', '2026-01-05T11:30:00Z');
      await react('help-bot-profile', '2026-01-05T11:31:00Z');
      // A live row of a metric a rebuild can't recount: the recount drops it.
      await sqlExecutor.execute(
        `insert into ${METRIC_ROLLUP_HOUR_TABLE} (hour_start, metric, scope, key1, key2, event_count, value_sum)
         values (:hour, :metric, 'global', '', '', 1, 42)`,
        { hour: HOUR_10, metric: MetricRollupHourMetric.PROFILE_COUNT }
      );
    });

    it('counts drops and droppers by the hour each drop was created, leaving out alert drops', async () => {
      await recountMetricRollupHour(sqlExecutor, OPTIONS);
      const rows = await rollupRows();

      expect(rows[MetricRollupHourMetric.DROP]).toEqual([
        // d1, d2 (10:59:59.999 is still 10:00), d3, c1, c3, the person's
        // drop in the priority wave and the deleted drop.
        { hour: HOUR_10, scope: 'global', events: 7, value: 7 },
        { hour: HOUR_11, scope: 'global', events: 3, value: 3 },
        { hour: HOUR_12, scope: 'global', events: 1, value: 1 },
        { hour: HOUR_13, scope: 'global', events: 1, value: 1 }
      ]);
      expect(rows[MetricRollupHourMetric.DROPPER_DROP]).toEqual([
        { hour: HOUR_10, scope: 'alice', events: 3, value: 3 },
        { hour: HOUR_10, scope: 'bob', events: 1, value: 1 },
        { hour: HOUR_10, scope: 'dave', events: 2, value: 2 },
        { hour: HOUR_10, scope: 'ops', events: 1, value: 1 },
        { hour: HOUR_11, scope: 'bob', events: 2, value: 2 },
        { hour: HOUR_11, scope: 'carol', events: 1, value: 1 },
        { hour: HOUR_12, scope: 'carol', events: 1, value: 1 },
        { hour: HOUR_13, scope: 'carol', events: 1, value: 1 }
      ]);
    });

    it("counts native Main Stage submissions, not the drop use case's legacy entries", async () => {
      await recountMetricRollupHour(sqlExecutor, OPTIONS);
      // entry-1 and entry-2. entry-3's hub is members-only, and entry-4
      // belongs to a legacy drop, counted only through MAIN_STAGE_WAVE_ID.
      expect(
        (await rollupRows())[MetricRollupHourMetric.MAIN_STAGE_SUBMISSION]
      ).toEqual([
        { hour: HOUR_10, scope: 'global', events: 1, value: 1 },
        { hour: HOUR_11, scope: 'global', events: 1, value: 1 }
      ]);
    });

    it('counts a legacy Main Stage submission once with MAIN_STAGE_WAVE_ID, winners included', async () => {
      await recountMetricRollupHour(sqlExecutor, WITH_LEGACY_STAGE);
      expect(
        (await rollupRows())[MetricRollupHourMetric.MAIN_STAGE_SUBMISSION]
      ).toEqual([
        { hour: HOUR_10, scope: 'global', events: 1, value: 1 },
        { hour: HOUR_11, scope: 'global', events: 1, value: 1 },
        // d5 once (not again through entry-4), and the winner d7.
        { hour: HOUR_12, scope: 'global', events: 1, value: 1 },
        { hour: HOUR_13, scope: 'global', events: 1, value: 1 }
      ]);
    });

    it("counts voters' own vote changes, not the system's credit cuts", async () => {
      await recountMetricRollupHour(sqlExecutor, OPTIONS);
      expect(
        (await rollupRows())[MetricRollupHourMetric.MAIN_STAGE_VOTE]
      ).toEqual([
        { hour: HOUR_10, scope: 'erin', events: 2, value: 2 },
        { hour: HOUR_11, scope: 'frank', events: 1, value: -3 }
      ]);
    });

    it('counts only what identities did with a timestamped row: a lower bound', async () => {
      await recountMetricRollupHour(sqlExecutor, OPTIONS);
      expect(
        (await rollupRows())[MetricRollupHourMetric.ACTIVE_IDENTITY]
      ).toEqual([
        // The members-only hub and the legacy stage were created the day before.
        {
          hour: '2026-01-04 08:00:00',
          scope: 'hub-creator',
          events: 1,
          value: 1
        },
        {
          hour: '2026-01-04 09:00:00',
          scope: 'stage-creator',
          events: 1,
          value: 1
        },
        { hour: HOUR_10, scope: 'alice', events: 3, value: 3 },
        { hour: HOUR_10, scope: 'bob', events: 1, value: 1 },
        { hour: HOUR_10, scope: 'dave', events: 2, value: 2 },
        { hour: HOUR_10, scope: 'grace', events: 1, value: 1 },
        { hour: HOUR_10, scope: 'heidi', events: 1, value: 1 },
        { hour: HOUR_10, scope: 'hub-creator', events: 1, value: 1 },
        { hour: HOUR_10, scope: 'ops', events: 1, value: 1 },
        { hour: HOUR_11, scope: 'bob', events: 2, value: 2 },
        { hour: HOUR_11, scope: 'carol', events: 1, value: 1 },
        // Not the help bot's reaction, nor ivan's system-made rating change.
        { hour: HOUR_11, scope: 'judy', events: 1, value: 1 },
        { hour: HOUR_12, scope: 'carol', events: 1, value: 1 },
        { hour: HOUR_13, scope: 'carol', events: 1, value: 1 }
      ]);
    });

    it('leaves out the metrics it cannot recount', async () => {
      await recountMetricRollupHour(sqlExecutor, OPTIONS);
      const rows = await rollupRows();

      expect(rows[MetricRollupHourMetric.PROFILE_COUNT]).toBeUndefined();
      expect(rows[MetricRollupHourMetric.TDH_ON_MAIN_STAGE_SUBMISSIONS]).toBe(
        undefined
      );
      expect(rows[MetricRollupHourMetric.XTDH_GRANTED]).toBeUndefined();
    });

    it("samples network TDH and consolidations once a day, at 00:00 of the TDH day, from the day's last block", async () => {
      for (const [block, total] of [
        [100, 1000],
        [101, 1100]
      ]) {
        await insertRow(TDH_GLOBAL_HISTORY_TABLE, {
          date: '2026-01-06',
          block,
          total_boosted_tdh: total
        });
      }
      await insertRow(TDH_GLOBAL_HISTORY_TABLE, {
        date: '2026-01-07',
        block: 120,
        total_boosted_tdh: 1300
      });
      const keys: [number, string][] = [
        [100, '0xa'],
        [101, '0xa-0xb'],
        [101, '0xc'],
        [101, '0xd-0xe-0xf'],
        [120, '0xa']
      ];
      for (const [block, key] of keys) {
        await insertRow(HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE, {
          block,
          consolidation_key: key,
          date: '2026-01-05 23:00:00'
        });
      }

      await recountMetricRollupHour(sqlExecutor, OPTIONS);
      let rows = await rollupRows();
      expect(rows[MetricRollupHourMetric.NETWORK_TDH]).toEqual([
        {
          hour: '2026-01-06 00:00:00',
          scope: 'global',
          events: 1,
          value: 1100
        },
        { hour: '2026-01-07 00:00:00', scope: 'global', events: 1, value: 1300 }
      ]);
      // tdhLoop samples it only with MAIN_STAGE_WAVE_ID set.
      expect(
        rows[MetricRollupHourMetric.CONSOLIDATIONS_FORMED]
      ).toBeUndefined();

      await recountMetricRollupHour(sqlExecutor, WITH_LEGACY_STAGE);
      rows = await rollupRows();
      expect(rows[MetricRollupHourMetric.CONSOLIDATIONS_FORMED]).toEqual([
        { hour: '2026-01-06 00:00:00', scope: 'global', events: 1, value: 2 },
        { hour: '2026-01-07 00:00:00', scope: 'global', events: 1, value: 0 }
      ]);
    });

    it('gives the same rows when run again', async () => {
      await recountMetricRollupHour(sqlExecutor, WITH_LEGACY_STAGE);
      const first = await rollupRows();
      await recountMetricRollupHour(sqlExecutor, WITH_LEGACY_STAGE);
      expect(await rollupRows()).toEqual(first);
    });
  }
);
