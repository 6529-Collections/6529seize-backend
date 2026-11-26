import { MetricRollupHourMetric } from '@/entities/IMetricRollupHour';
import {
  ACTIVITY_SOURCES,
  hourOfMillisSql,
  hourOfTimestampSql,
  hourOfUtcDatetimeSql,
  NOT_RECOUNTED,
  RecountOptions,
  recountStatements
} from '@/metrics/metrics-rebuild';
import { METRICS_RECOUNT_READS } from '@/metrics/metrics-rebuild.tables';

const NONE: RecountOptions = {
  mainStageWaveId: null,
  alertsWaveId: null,
  alertsBotProfileId: null,
  priorityAlertsWaveId: null
};
const ALL: RecountOptions = {
  mainStageWaveId: 'stage',
  alertsWaveId: 'alerts',
  alertsBotProfileId: 'alert-bot',
  priorityAlertsWaveId: 'priority'
};

const sqlOf = (options: RecountOptions, metric: MetricRollupHourMetric) =>
  recountStatements(options).find((s) => s.metric === metric)?.sql ?? '';

describe('metric_rollup_hour recount statements', () => {
  it('takes the hour by arithmetic, not through the session time zone', () => {
    expect(hourOfMillisSql('d.created_at')).toBe(
      "date_add('1970-01-01 00:00:00', interval floor(d.created_at / 3600000) hour)"
    );
    expect(hourOfTimestampSql('r.created_at')).toBe(
      "date_add('1970-01-01 00:00:00', interval floor(unix_timestamp(r.created_at) / 3600) hour)"
    );
    expect(hourOfUtcDatetimeSql('l.created_at')).toBe(
      "timestamp(date_format(l.created_at, '%Y-%m-%d %H:00:00'))"
    );
  });

  it('recounts every metric but the three it cannot, keyed as live keys them', () => {
    const recounted = recountStatements(ALL).map((s) => s.metric);
    expect(new Set([...recounted, ...Object.keys(NOT_RECOUNTED)])).toEqual(
      new Set(Object.values(MetricRollupHourMetric))
    );
    expect(Object.keys(NOT_RECOUNTED)).toEqual([
      MetricRollupHourMetric.TDH_ON_MAIN_STAGE_SUBMISSIONS,
      MetricRollupHourMetric.PROFILE_COUNT,
      MetricRollupHourMetric.XTDH_GRANTED
    ]);
    for (const statement of recountStatements(ALL)) {
      expect(statement.sql).toContain(':metric');
      expect(statement.sql).toContain("'', ''");
    }
  });

  it('counts only native submissions through entries, and the legacy wave only with MAIN_STAGE_WAVE_ID', () => {
    const without = sqlOf(NONE, MetricRollupHourMetric.MAIN_STAGE_SUBMISSION);
    expect(without).toContain("ed.drop_type = 'COMPETITION'");
    expect(without).not.toContain(':mainStageWaveId');
    const withWave = sqlOf(ALL, MetricRollupHourMetric.MAIN_STAGE_SUBMISSION);
    expect(withWave).toContain(':mainStageWaveId');
    expect(withWave).toContain("d.drop_type in ('PARTICIPATORY', 'WINNER')");
    expect(recountStatements(NONE).map((s) => s.metric)).not.toContain(
      MetricRollupHourMetric.CONSOLIDATIONS_FORMED
    );
  });

  it("leaves out the system's vote cuts, alert drops and the help bot's reactions", () => {
    expect(sqlOf(NONE, MetricRollupHourMetric.MAIN_STAGE_VOTE)).toContain(
      "<> 'CREDIT_OVERSPENT'"
    );
    const drops = sqlOf(ALL, MetricRollupHourMetric.DROP);
    expect(drops).toContain(':alertsBotProfileId');
    expect(drops).toContain(':priorityAlertsWaveId');
    expect(sqlOf(NONE, MetricRollupHourMetric.DROP)).not.toContain(
      ':alertsWaveId'
    );
    expect(sqlOf(NONE, MetricRollupHourMetric.ACTIVE_IDENTITY)).toContain(
      "normalised_handle = 'help6529'"
    );
  });

  it('builds active identities from exactly the listed actions', () => {
    const sql = sqlOf(NONE, MetricRollupHourMetric.ACTIVE_IDENTITY);
    for (const source of ACTIVITY_SOURCES) {
      expect(sql).toContain(source.sql(NONE));
      expect(METRICS_RECOUNT_READS).toContain(source.table);
    }
    expect(sql.split('union all').length).toBe(
      // The drops source is itself two selects: drops and deleted drops.
      ACTIVITY_SOURCES.length + 1
    );
  });
});
