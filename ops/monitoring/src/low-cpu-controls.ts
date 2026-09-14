import type { EventBridgeEvent } from 'aws-lambda';
import { hash, record, type Environment } from './contract.js';

export interface LowCpuControlRule {
  id: string;
  identityHash: string;
  dimensionsHash: string;
  namespace: string;
  statistic: string;
  period: number;
  evaluations: number;
  threshold: number;
}

// Exact audited identities/dimension sets, not name-prefix classification.
// Hashes avoid publishing infrastructure identifiers in the policy or fixtures.
export const LOW_CPU_CONTROLS: readonly LowCpuControlRule[] = [
  {
    id: 'RDS_READER_LOW_CPU',
    identityHash:
      'd687fac70bd0c2bce8e3a5933511c2747cd717bc98e3f51fbe5913770d99bf0f',
    dimensionsHash:
      'cd9f886b82f3458a81c691a69aad2d3cd5172b4fa9fabc553bf35085b5d084bb',
    namespace: 'AWS/RDS',
    statistic: 'Average',
    period: 60,
    evaluations: 15,
    threshold: 45
  },
  {
    id: 'EC2_AVERAGE_LOW_CPU',
    identityHash:
      '8103310edbdf63fbbf481b767e5e70d622c4f5842b4d9cc3891d2f44b5096d49',
    dimensionsHash:
      '48cb39da7d4e0b120ed463e443175f3ad2e3ccb1a29b5437e61185ca7854313f',
    namespace: 'AWS/EC2',
    statistic: 'Average',
    period: 300,
    evaluations: 1,
    threshold: 20
  },
  {
    id: 'EC2_SUM_LOW_CPU',
    identityHash:
      '969cfd665a678cc73b9cc0f1058c502d7323de83715937c88e6faba22d31c51b',
    dimensionsHash:
      '6e73f7457280bd3aae9dc0624c6fdf46ecb9522bcc6859a156db2d1a995a1bfc',
    namespace: 'AWS/EC2',
    statistic: 'Sum',
    period: 60,
    evaluations: 1,
    threshold: 20
  }
];

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function metricMatches(
  detail: Record<string, unknown>,
  rule: LowCpuControlRule
): boolean {
  const configuration = record(detail.configuration);
  if (!onlyKeys(configuration, ['description', 'metrics'])) return false;
  const metrics = configuration.metrics;
  if (!Array.isArray(metrics) || metrics.length !== 1) return false;
  const entry = record(metrics[0]);
  const stat = record(entry.metricStat);
  const metric = record(stat.metric);
  const dimensions = Object.entries(record(metric.dimensions)).sort(([a], [b]) => {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
  return (
    onlyKeys(entry, ['id', 'metricStat', 'returnData']) &&
    (entry.returnData === undefined || entry.returnData === true) &&
    onlyKeys(stat, ['metric', 'period', 'stat', 'unit']) &&
    onlyKeys(metric, ['namespace', 'name', 'dimensions']) &&
    metric.namespace === rule.namespace &&
    metric.name === 'CPUUtilization' &&
    stat.period === rule.period &&
    stat.stat === rule.statistic &&
    (stat.unit === undefined || stat.unit === 'Percent') &&
    dimensions.every(([, value]) => typeof value === 'string') &&
    hash(JSON.stringify(dimensions)) === rule.dimensionsHash
  );
}

function utcMillis(value: unknown): number | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|\+00:?00)$/.test(
      value
    )
  )
    return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
    ? parsed
    : undefined;
}

function metricDate(value: number): string {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCFullYear() % 100)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

interface Point {
  value: number;
  timestamp: number;
}
interface StateEvidence {
  recent: number[];
  points: Point[];
}

function numeric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function stateEvidence(
  state: Record<string, unknown>,
  rule: LowCpuControlRule
): StateEvidence | undefined {
  if (
    !onlyKeys(state, ['value', 'reason', 'reasonData', 'timestamp']) ||
    typeof state.reasonData !== 'string' ||
    state.reasonData.length > 8192
  )
    return undefined;
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(state.reasonData));
  } catch {
    return undefined;
  }
  const recent = data.recentDatapoints;
  const evaluated = data.evaluatedDatapoints;
  const start = utcMillis(data.startDate);
  const query = utcMillis(data.queryDate);
  if (
    !onlyKeys(data, [
      'version',
      'unit',
      'statistic',
      'period',
      'threshold',
      'startDate',
      'queryDate',
      'recentDatapoints',
      'evaluatedDatapoints'
    ]) ||
    data.version !== '1.0' ||
    data.unit !== 'Percent' ||
    data.statistic !== rule.statistic ||
    data.period !== rule.period ||
    data.threshold !== rule.threshold ||
    start === undefined ||
    query === undefined ||
    start > query ||
    !Array.isArray(recent) ||
    recent.length !== rule.evaluations ||
    !recent.every(numeric) ||
    !Array.isArray(evaluated) ||
    evaluated.length === 0 ||
    evaluated.length > rule.evaluations
  )
    return undefined;
  const points: Point[] = [];
  for (const item of evaluated) {
    const point = record(item);
    const timestamp = utcMillis(point.timestamp);
    if (
      !onlyKeys(point, ['value', 'sampleCount', 'timestamp']) ||
      !numeric(point.value) ||
      !numeric(point.sampleCount) ||
      point.sampleCount === 0 ||
      timestamp === undefined ||
      timestamp < start ||
      timestamp > query ||
      (points.length > 0 && timestamp >= points.at(-1)!.timestamp)
    )
      return undefined;
    points.push({ value: point.value, timestamp });
  }
  return { recent, points };
}

function lowStateMatches(
  state: Record<string, unknown>,
  rule: LowCpuControlRule,
  recovery: boolean
): boolean {
  if (state.value !== (recovery ? 'OK' : 'ALARM')) return false;
  const evidence = stateEvidence(state, rule);
  if (!evidence) return false;
  const { recent, points } = evidence;
  const threshold = rule.threshold.toFixed(1);
  const rendered = (point: Point) =>
    `${point.value} (${metricDate(point.timestamp)})`;
  if (recovery) {
    if (
      points.length !== 1 ||
      points[0]!.value < rule.threshold ||
      recent.filter((value) => value >= rule.threshold).length !== 1 ||
      !recent.includes(points[0]!.value)
    )
      return false;
    return (
      state.reason ===
      `Threshold Crossed: 1 datapoint [${rendered(points[0]!)}] was not less than the threshold (${threshold}).`
    );
  }
  if (
    points.length !== rule.evaluations ||
    !recent.every((value) => value < rule.threshold) ||
    !points.every((point, i) => point.value === recent[recent.length - 1 - i])
  )
    return false;
  const expected =
    points.length === 1
      ? `Threshold Crossed: 1 datapoint [${rendered(points[0]!)}] was less than the threshold (${threshold}).`
      : `Threshold Crossed: ${rule.evaluations} datapoints were less than the threshold (${threshold}). The most recent datapoints which crossed the threshold: [${points.slice(0, 5).map(rendered).join(', ')}].`;
  return state.reason === expected;
}

// This proves the observed transition's low-direction semantics. CloudWatch's
// event does not expose every action/config setting or action result. Unknown
// metadata/grammar alerts; a match does not establish successful scaling.
export function classifyLowCpuControl(
  event: EventBridgeEvent<string, unknown>,
  environment: Environment,
  rules: readonly LowCpuControlRule[] = LOW_CPU_CONTROLS
): LowCpuControlRule | undefined {
  if (
    environment !== 'prod' ||
    event.source !== 'aws.cloudwatch' ||
    event['detail-type'] !== 'CloudWatch Alarm State Change'
  )
    return undefined;
  const detail = record(event.detail);
  if (
    !onlyKeys(detail, [
      'alarmName',
      'configuration',
      'state',
      'previousState'
    ]) ||
    !onlyKeys(record(detail.previousState), [
      'value',
      'reason',
      'reasonData',
      'timestamp'
    ]) ||
    typeof detail.alarmName !== 'string' ||
    detail.alarmName.length > 255
  )
    return undefined;
  const identity = hash(`${event.account}:${event.region}:${detail.alarmName}`);
  const rule = rules.find((candidate) => candidate.identityHash === identity);
  if (!rule || !metricMatches(detail, rule)) return undefined;
  const state = record(detail.state);
  if (state.value === 'ALARM')
    return lowStateMatches(state, rule, false) ? rule : undefined;
  return lowStateMatches(state, rule, true) &&
    lowStateMatches(record(detail.previousState), rule, false)
    ? rule
    : undefined;
}
