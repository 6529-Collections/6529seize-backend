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
  TDH_GLOBAL_HISTORY_TABLE,
  WAVES_TABLE
} from '@/constants';
import { publicCompetitionWaveSql } from '@/competitions/competition-main-stage.repository';
import { DropType } from '@/entities/IDrop';
import { MetricRollupHourMetric } from '@/entities/IMetricRollupHour';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { env } from '@/env';
import { HELP_BOT_HANDLE } from '@/help-bot/help-bot.config';
import { Logger } from '@/logging';
import { dbSupplier, SqlExecutor } from '@/sql-executor';

/**
 * metric_rollup_hour recounted from the tables its events left behind, for
 * a rebuild. Live writes (MetricsRecorder) are unchanged; this is only what
 * a rebuild puts back.
 *
 * - Counters, by the UTC hour each event happened (live rows take the hour
 *   they were written, so the two can differ at an hour's edge): DROP,
 *   DROPPER_DROP, MAIN_STAGE_SUBMISSION, MAIN_STAGE_VOTE, and
 *   ACTIVE_IDENTITY as a lower bound of what identities did (only the
 *   actions in {@link ACTIVITY_SOURCES} are seen).
 * - Daily samples at 00:00 UTC of each TDH day: NETWORK_TDH and
 *   CONSOLIDATIONS_FORMED (live samples take the hour the loop ran).
 * - Not recounted: see {@link NOT_RECOUNTED}.
 * - Rows the system writes, which live doesn't count, are left out: alert
 *   drops and the help bot's reactions.
 *
 * Rows are keyed as MetricsRecorder keys them: scope `global` unless the
 * metric is per identity, key1 and key2 empty.
 *
 * Live counts some actions a rebuild can't see, so ACTIVE_IDENTITY is a lower
 * bound: subscribing to or unsubscribing from a drop or a wave; removing a
 * boost, and a boost later removed (its row is gone); updating or deleting a
 * wave or its hub; pinning, unpinning, muting and unmuting a wave, and
 * setting its pinned drop; creating a group or changing its visibility; a
 * reaction later removed or replaced. Drops lost when their wave is deleted
 * and deleted Main Stage submissions (a deleted drop keeps no type) are gone
 * from the counters too, and identity merges rewrite author and voter ids,
 * so a merged identity's past events count under the surviving id.
 */

const logger = Logger.get('METRICS_REBUILD');

/** Metrics a rebuild can't recount, and why. */
export const NOT_RECOUNTED: Readonly<
  Partial<Record<MetricRollupHourMetric, string>>
> = {
  [MetricRollupHourMetric.TDH_ON_MAIN_STAGE_SUBMISSIONS]:
    'Total active Main Stage votes at the moment of each TDH run; a rebuild would need a replay of the vote history up to each of those moments; not attempted.',
  [MetricRollupHourMetric.PROFILE_COUNT]:
    'Identities with a real handle at the moment of each TDH run; a rebuild would need a replay of every handle change up to each of those moments; not attempted.',
  [MetricRollupHourMetric.XTDH_GRANTED]:
    'No table keeps the granted xTDH total over time: the stats slots are refilled in place; a rebuild would need a replay of every stats run; not attempted.'
};

/** Where the system writes rows that live doesn't count. */
export interface RecountOptions {
  /** MAIN_STAGE_WAVE_ID: the legacy Main Stage wave, as live reads it. */
  readonly mainStageWaveId: string | null;
  /** ALERTS_WAVE_ID and ALERTS_BOT_PROFILE_ID: the alert endpoint's drops. */
  readonly alertsWaveId: string | null;
  readonly alertsBotProfileId: string | null;
  /** PRIORITY_ALERTS_WAVE: priority alert drops. */
  readonly priorityAlertsWaveId: string | null;
}

export function recountOptionsFromEnv(): RecountOptions {
  return {
    mainStageWaveId: env.getStringOrNull('MAIN_STAGE_WAVE_ID'),
    alertsWaveId: env.getStringOrNull('ALERTS_WAVE_ID'),
    alertsBotProfileId: env.getStringOrNull('ALERTS_BOT_PROFILE_ID'),
    priorityAlertsWaveId: env.getStringOrNull('PRIORITY_ALERTS_WAVE')
  };
}

const NO_OPTIONS: RecountOptions = {
  mainStageWaveId: null,
  alertsWaveId: null,
  alertsBotProfileId: null,
  priorityAlertsWaveId: null
};

const HOUR_MS = 3_600_000;

/** The UTC hour of epoch milliseconds in `column`, as a DATETIME. */
export function hourOfMillisSql(column: string): string {
  return `date_add('1970-01-01 00:00:00', interval floor(${column} / ${HOUR_MS}) hour)`;
}

/** The hour of a DATETIME column holding UTC wall time, as a DATETIME. */
export function hourOfUtcDatetimeSql(column: string): string {
  return `timestamp(date_format(${column}, '%Y-%m-%d %H:00:00'))`;
}

/**
 * The UTC hour of a TIMESTAMP column: unix_timestamp() of a TIMESTAMP column
 * is its stored UTC value, whatever the session's time zone.
 */
export function hourOfTimestampSql(column: string): string {
  return `date_add('1970-01-01 00:00:00', interval floor(unix_timestamp(${column}) / 3600) hour)`;
}

/** Competitions designated Main Stage, joined as MetricsRecorder checks them. */
const MAIN_STAGE_COMPETITIONS = `select c.id from ${COMPETITIONS_TABLE} c
  join ${COMPETITION_CAPABILITIES_TABLE} cap on cap.competition_id = c.id and cap.wave_id = c.wave_id
  join ${WAVES_TABLE} hub on hub.id = c.wave_id and ${publicCompetitionWaveSql('hub')}
  where cap.capability = 'MAIN_STAGE'`;

/** The help bot's profile, found by its handle as the help bot finds it. */
const HELP_BOT_PROFILE = `select i.profile_id from ${IDENTITIES_TABLE} i
  where i.normalised_handle = '${HELP_BOT_HANDLE}' and i.profile_id is not null`;

/**
 * Leaves out the drops the system writes without a rollup: the alert
 * endpoint's (its wave and bot) and priority alerts. A deleted drop keeps no
 * title, so every deleted drop of the priority alert wave is left out.
 */
function humanDropsOnly(
  alias: string,
  hasTitle: boolean,
  options: RecountOptions
): string {
  const conditions = [`${alias}.created_at is not null`];
  if (options.alertsWaveId && options.alertsBotProfileId) {
    conditions.push(
      `not (${alias}.wave_id = :alertsWaveId and ${alias}.author_id = :alertsBotProfileId)`
    );
  }
  if (options.priorityAlertsWaveId) {
    conditions.push(
      hasTitle
        ? `not (${alias}.wave_id = :priorityAlertsWaveId and coalesce(${alias}.title, '') like 'Priority Alert: %')`
        : `${alias}.wave_id <> :priorityAlertsWaveId`
    );
  }
  return `where ${conditions.join(' and ')}`;
}

/** Drops created, deleted ones included: (hour_start, scope = author). */
function createdDrops(options: RecountOptions): string {
  return `select ${hourOfMillisSql('d.created_at')} as hour_start, d.author_id as scope
     from ${DROPS_TABLE} d ${humanDropsOnly('d', true, options)}
     union all
     select ${hourOfMillisSql('dd.created_at')}, dd.author_id
     from ${DELETED_DROPS_TABLE} dd ${humanDropsOnly('dd', false, options)}`;
}

export interface ActivitySource {
  /** The action, as the PR text and the docs name it. */
  readonly action: string;
  readonly table: string;
  /** `select hour_start, scope` rows of the action. */
  readonly sql: (options: RecountOptions) => string;
}

/** The actions ACTIVE_IDENTITY counts after a rebuild: each leaves a timestamped row. */
export const ACTIVITY_SOURCES: readonly ActivitySource[] = [
  {
    action: 'creating a drop (deleted drops included)',
    table: DROPS_TABLE,
    sql: createdDrops
  },
  {
    action: "reacting to a drop (not the help bot's reactions)",
    table: DROP_REACTIONS_TABLE,
    sql: () =>
      `select ${hourOfTimestampSql('r.created_at')}, r.profile_id from ${DROP_REACTIONS_TABLE} r
       where r.profile_id not in (${HELP_BOT_PROFILE})`
  },
  {
    action: 'boosting a drop',
    table: DROP_BOOSTS_TABLE,
    sql: () =>
      `select ${hourOfMillisSql('b.boosted_at')}, b.booster_id from ${DROP_BOOSTS_TABLE} b`
  },
  {
    action: 'creating a wave',
    table: WAVES_TABLE,
    sql: () =>
      `select ${hourOfMillisSql('w.created_at')}, w.created_by from ${WAVES_TABLE} w`
  },
  {
    action:
      'changing a REP or NIC rating as the rater (not a change the system makes)',
    table: PROFILES_ACTIVITY_LOGS_TABLE,
    sql: () =>
      `select ${hourOfUtcDatetimeSql('l.created_at')}, l.profile_id from ${PROFILES_ACTIVITY_LOGS_TABLE} l
       where l.type = '${ProfileActivityLogType.RATING_EDIT}'
         and l.created_at is not null
         and json_unquote(json_extract(l.contents, '$.change_reason')) = 'USER_EDIT'`
  }
];

const INSERT_INTO = `insert into ${METRIC_ROLLUP_HOUR_TABLE}
  (hour_start, metric, scope, key1, key2, event_count, value_sum)`;

export interface RecountStatement {
  readonly metric: MetricRollupHourMetric;
  readonly sql: string;
}

/** The INSERT ... SELECT statements of a recount, one per metric, run on an empty table. */
export function recountStatements(
  options: RecountOptions = NO_OPTIONS
): RecountStatement[] {
  // The drop use case records a legacy Main Stage submission (a
  // participatory drop in MAIN_STAGE_WAVE_ID, WINNER if it won before native
  // competitions; since then, winning changes the entry, not the drop). It
  // also writes an entry for that drop, without a rollup: only the entries
  // of native submissions, whose drop is a COMPETITION drop, are counted.
  const legacyMainStageDrops = options.mainStageWaveId
    ? `select ${hourOfMillisSql('d.created_at')} as hour_start from ${DROPS_TABLE} d
       where d.wave_id = :mainStageWaveId
         and d.drop_type in ('${DropType.PARTICIPATORY}', '${DropType.WINNER}')
       union all `
    : '';
  const statements: RecountStatement[] = [
    {
      metric: MetricRollupHourMetric.DROP,
      sql: `${INSERT_INTO}
        select t.hour_start, :metric, 'global', '', '', count(*), count(*)
        from (${createdDrops(options)}) t
        group by t.hour_start`
    },
    {
      metric: MetricRollupHourMetric.DROPPER_DROP,
      sql: `${INSERT_INTO}
        select t.hour_start, :metric, t.scope, '', '', count(*), count(*)
        from (${createdDrops(options)}) t
        group by t.hour_start, t.scope`
    },
    {
      metric: MetricRollupHourMetric.MAIN_STAGE_SUBMISSION,
      sql: `${INSERT_INTO}
        select t.hour_start, :metric, 'global', '', '', count(*), count(*)
        from (
          ${legacyMainStageDrops}
          select ${hourOfMillisSql('e.submitted_at')} as hour_start
          from ${COMPETITION_ENTRIES_TABLE} e
          join ${DROPS_TABLE} ed on ed.id = e.drop_id and ed.drop_type = '${DropType.COMPETITION}'
          where e.competition_id in (${MAIN_STAGE_COMPETITIONS})
        ) t
        group by t.hour_start`
    },
    {
      // Voters' own changes: the system's credit reductions record no rollup.
      metric: MetricRollupHourMetric.MAIN_STAGE_VOTE,
      sql: `${INSERT_INTO}
        select ${hourOfMillisSql('v.occurred_at')} as hour_start, :metric, v.voter_profile_id, '', '',
          count(*), sum(v.value - v.previous_value)
        from ${COMPETITION_VOTE_HISTORY_TABLE} v
        where v.value <> v.previous_value
          and coalesce(json_unquote(json_extract(v.contents, '$.reason')), '') <> 'CREDIT_OVERSPENT'
          and v.competition_id in (${MAIN_STAGE_COMPETITIONS})
        group by hour_start, v.voter_profile_id`
    },
    {
      metric: MetricRollupHourMetric.ACTIVE_IDENTITY,
      sql: `${INSERT_INTO}
        select t.hour_start, :metric, t.scope, '', '', count(*), count(*)
        from (
          ${ACTIVITY_SOURCES.map((source) => source.sql(options)).join('\nunion all\n')}
        ) t
        group by t.hour_start, t.scope`
    },
    {
      // The day's last block wins, as the last live write of an hour does.
      metric: MetricRollupHourMetric.NETWORK_TDH,
      sql: `${INSERT_INTO}
        select timestamp(g.date), :metric, 'global', '', '', 1, g.total_boosted_tdh
        from ${TDH_GLOBAL_HISTORY_TABLE} g
        where g.block = (
          select max(g2.block) from ${TDH_GLOBAL_HISTORY_TABLE} g2 where g2.date = g.date
        )`
    }
  ];
  if (options.mainStageWaveId) {
    // tdhLoop samples it only with MAIN_STAGE_WAVE_ID set, counting the
    // consolidated TDH keys that join wallets (they hold a '-').
    statements.push({
      metric: MetricRollupHourMetric.CONSOLIDATIONS_FORMED,
      sql: `${INSERT_INTO}
        select timestamp(g.date), :metric, 'global', '', '', 1,
          sum(h.consolidation_key like '%-%')
        from ${TDH_GLOBAL_HISTORY_TABLE} g
        join ${HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE} h on h.block = g.block
        where g.block = (
          select max(g2.block) from ${TDH_GLOBAL_HISTORY_TABLE} g2 where g2.date = g.date
        )
        group by g.date`
    });
  }
  return statements;
}

/** Rows each metric got. */
export type RecountSummary = Partial<Record<MetricRollupHourMetric, number>>;

/**
 * Replaces metric_rollup_hour with the recount, in one transaction. Rows of
 * the metrics in {@link NOT_RECOUNTED} are dropped with the rest.
 */
export async function recountMetricRollupHour(
  db: SqlExecutor = dbSupplier(),
  options: RecountOptions = recountOptionsFromEnv()
): Promise<RecountSummary> {
  const summary: RecountSummary = {};
  await db.executeNativeQueriesInTransaction(async (connection) => {
    await db.execute(`delete from ${METRIC_ROLLUP_HOUR_TABLE}`, undefined, {
      wrappedConnection: connection
    });
    for (const statement of recountStatements(options)) {
      await db.execute(
        statement.sql,
        { ...options, metric: statement.metric },
        { wrappedConnection: connection }
      );
      const [row] = await db.execute<{ n: number | string }>(
        `select count(*) as n from ${METRIC_ROLLUP_HOUR_TABLE} where metric = :metric`,
        { metric: statement.metric },
        { wrappedConnection: connection }
      );
      summary[statement.metric] = Number(row?.n ?? 0);
    }
  });
  logger.info(`[METRIC ROLLUP RECOUNTED] ${JSON.stringify(summary)}`);
  return summary;
}

/**
 * Rebuild check seed: the seeded world's live-written rows are replaced by
 * the recount, so the check compares a recount with a recount.
 */
export async function seedMetricRollupHour(): Promise<void> {
  await recountMetricRollupHour();
}

/** Rebuild check rebuilder: the recount, from the rebuilt tables. */
export async function rebuildMetricRollupHour(): Promise<void> {
  await recountMetricRollupHour();
}
