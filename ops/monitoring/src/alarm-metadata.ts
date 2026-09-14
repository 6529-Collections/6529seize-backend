import { parseAlarmMetadata, record } from './contract.js';

// AWS reasonData is structured JSON; never forward the free-form reason,
// description, dimensions, metric expressions, or the original reasonData.
function alarmThreshold(state: unknown): unknown {
  const reasonData = record(state).reasonData;
  if (typeof reasonData !== 'string' || reasonData.length > 8192)
    return undefined;
  try {
    return record(JSON.parse(reasonData)).threshold;
  } catch {
    return undefined;
  }
}

export function cloudWatchAlarmMetadata(detail: Record<string, unknown>) {
  const metrics = record(detail.configuration).metrics;
  // A metric-math/composite alarm must not be labeled as its first input metric.
  const metricStat =
    Array.isArray(metrics) && metrics.length === 1
      ? record(record(metrics[0]).metricStat)
      : {};
  const metric = record(metricStat.metric);
  return parseAlarmMetadata({
    name: detail.alarmName,
    namespace: metric.namespace,
    metric: metric.name,
    statistic: metricStat.stat,
    periodSeconds: metricStat.period,
    threshold: alarmThreshold(detail.state)
  });
}
