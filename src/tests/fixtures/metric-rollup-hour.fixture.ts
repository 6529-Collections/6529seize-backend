import { METRIC_ROLLUP_HOUR_TABLE } from '@/constants';
import { MetricRollupHourMetric } from '@/entities/IMetricRollupHour';
import { sqlExecutor } from '@/sql-executor';
import * as mysql from 'mysql';

type ColumnInfo = {
  name: string;
  type: string;
  nullable: string;
  hasDefault: number | string;
  extra: string;
};

/** A neutral value for a NOT NULL column the test doesn't care about. */
function neutralValue(type: string): unknown {
  if (type === 'json') return '{}';
  if (type === 'date') return '1970-01-01';
  if (type === 'datetime' || type === 'timestamp') return '1970-01-01 00:00:01';
  if (['varchar', 'char', 'text', 'mediumtext', 'longtext'].includes(type)) {
    return '';
  }
  return 0;
}

/**
 * Inserts `row` into `table`, giving every other NOT NULL column without a
 * default a neutral value, so a test names only the columns it reads.
 * Objects become JSON; strings go in as written (times as UTC wall time).
 */
export async function insertRow(
  table: string,
  row: Record<string, unknown>
): Promise<void> {
  const columns = await sqlExecutor.execute<ColumnInfo>(
    `select column_name as name, data_type as type, is_nullable as nullable,
       column_default is not null as hasDefault, extra as extra
     from information_schema.columns
     where table_schema = database() and table_name = :table`,
    { table }
  );
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    const required =
      column.nullable === 'NO' &&
      !Number(column.hasDefault) &&
      !column.extra.includes('auto_increment');
    if (required) values[column.name] = neutralValue(column.type);
  }
  for (const [name, value] of Object.entries(row)) {
    values[name] =
      value !== null && typeof value === 'object' && !(value instanceof Date)
        ? JSON.stringify(value)
        : value;
  }
  const names = Object.keys(values);
  await sqlExecutor.execute(
    `insert into ${mysql.escapeId(table)} (${names.map((name) => mysql.escapeId(name)).join(', ')})
     values (${names.map((name) => mysql.escape(values[name])).join(', ')})`
  );
}

export type RollupRow = {
  hour: string;
  scope: string;
  events: number;
  value: number;
};

/** metric_rollup_hour by metric, in hour and scope order; hours as UTC wall time. */
export async function rollupRows(): Promise<
  Partial<Record<MetricRollupHourMetric, RollupRow[]>>
> {
  const rows = await sqlExecutor.execute<{
    metric: MetricRollupHourMetric;
    hour: string;
    scope: string;
    events: number | string;
    value: number | string;
  }>(
    `select metric, date_format(hour_start, '%Y-%m-%d %H:%i:%s') as hour,
       scope, event_count as events, value_sum as value
     from ${METRIC_ROLLUP_HOUR_TABLE}
     where key1 = '' and key2 = ''
     order by metric, hour_start, scope`
  );
  const byMetric: Partial<Record<MetricRollupHourMetric, RollupRow[]>> = {};
  for (const row of rows) {
    (byMetric[row.metric] ??= []).push({
      hour: row.hour,
      scope: row.scope,
      events: Number(row.events),
      value: Number(row.value)
    });
  }
  return byMetric;
}
