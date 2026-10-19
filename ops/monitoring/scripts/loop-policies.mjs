import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

const root = new URL('../../../', import.meta.url);
const tags = ['!Sub', '!GetAtt', '!Ref', '!Join', '!If'].map((tag) => ({
  tag,
  resolve: (value) => value
}));

export function intervalSeconds(expression) {
  const rate = /^rate\((\d+) (minute|hour|day)s?\)$/.exec(expression ?? '');
  if (rate)
    return Number(rate[1]) * { minute: 60, hour: 3600, day: 86400 }[rate[2]];
  // Cron is deliberately not guessed: fixed-time/deadline jobs still get a policy.
  return undefined;
}

function resourceReference(value) {
  const reference = typeof value === 'string' ? value : value?.['Fn::GetAtt'];
  return Array.isArray(reference)
    ? reference[0]
    : typeof reference === 'string'
      ? reference.split('.')[0]
      : undefined;
}

function queueSchedules(config, events) {
  const queues = events
    .map((event) => resourceReference(event.sqs?.arn))
    .filter(Boolean);
  return Object.values(config.resources?.Resources ?? {}).flatMap(
    (resource) => {
      if (
        resource.Type !== 'AWS::Events::Rule' ||
        resource.Properties?.State === 'DISABLED'
      )
        return [];
      const properties = resource.Properties;
      return properties.Targets?.some((target) =>
        queues.includes(resourceReference(target.Arn))
      )
        ? [properties.ScheduleExpression].filter(Boolean)
        : [];
    }
  );
}

export async function loopPolicies(catalog, environment) {
  const policies = [];
  for (const service of catalog.services) {
    if (
      !service.allowed_environments.includes(environment) ||
      service.deploy_adapter !== 'serverless'
    )
      continue;
    const file = new URL(`src/${service.name}/serverless.yaml`, root);
    const doc = parseDocument(await readFile(file, 'utf8'), {
      customTags: tags
    });
    if (doc.errors.length)
      throw new Error(`Invalid loop configuration: ${service.name}`);
    const config = doc.toJS();
    for (const fn of Object.values(config.functions ?? {})) {
      if (!service.verification_targets.includes(fn.name)) continue;
      const events = fn.events ?? [];
      const scheduled = events.some(
        (event) => event.schedule && event.schedule.enabled !== false
      );
      const queued = events.some((event) => event.sqs);
      if (!scheduled && !queued) continue;
      const intervals = events.flatMap((event) => {
        const schedule = event.schedule;
        if (schedule?.enabled === false) return [];
        const rate = typeof schedule === 'string' ? schedule : schedule?.rate;
        return (Array.isArray(rate) ? rate : [rate])
          .map(intervalSeconds)
          .filter(Number.isFinite);
      });
      intervals.push(
        ...queueSchedules(config, events)
          .map(intervalSeconds)
          .filter(Number.isFinite)
      );
      const interval = intervals.length ? Math.min(...intervals) : undefined;
      const concurrency =
        fn.reservedConcurrency ?? config.provider?.reservedConcurrency;
      const timeout = fn.timeout ?? config.provider?.timeout ?? 6;
      const decision = fn.name === 'waveDecisionExecutionLoop';
      policies.push({
        service: fn.name,
        ...(interval ? { intervalSeconds: interval } : {}),
        ...(typeof concurrency === 'number'
          ? { reservedConcurrency: concurrency }
          : {}),
        expectedOverlap:
          interval !== undefined && interval <= 300 && concurrency === 1,
        delaySeconds: decision ? 120 : Math.max(600, (interval ?? 60) * 2),
        stallSeconds: decision
          ? 300
          : Math.max(timeout + 300, (interval ?? 60) * 3),
        freshSeconds: decision ? 120 : Math.max(timeout + 120, (interval ?? 60) * 2),
        ...(fn.name === 'delegationsLoop'
          ? { optionalOperations: ['recalculation'] }
          : {}),
        ...(decision
          ? {
              operationBudgets: {
                publication: { delaySeconds: 600, stallSeconds: 3900 }
              }
            }
          : {}),
        operations:
          fn.name === 'delegationsLoop'
            ? ['indexing', 'recalculation']
            : decision
              ? ['decisions', 'native_execution', 'publication']
              : ['processing']
      });
    }
  }
  return policies.sort((a, b) => a.service.localeCompare(b.service));
}
