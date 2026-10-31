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
  if (typeof value === 'string') {
    const substitution = /\$\{([A-Za-z0-9]+)\.Arn\}/.exec(value);
    return substitution?.[1] ?? value.split('.')[0];
  }
  const reference = value?.['Fn::GetAtt'] ?? value?.['Fn::Sub'];
  if (Array.isArray(reference)) return resourceReference(reference[0]);
  if (typeof reference === 'string') return resourceReference(reference);
  return undefined;
}

function queueSchedules(config, events) {
  const queues = new Set(
    events.map((event) => resourceReference(event.sqs?.arn)).filter(Boolean)
  );
  return Object.values(config.resources?.Resources ?? {}).flatMap(
    (resource) => {
      if (
        resource.Type !== 'AWS::Events::Rule' ||
        resource.Properties?.State === 'DISABLED'
      )
        return [];
      const properties = resource.Properties;
      return properties.Targets?.some((target) =>
        queues.has(resourceReference(target.Arn))
      )
        ? [properties.ScheduleExpression].filter(Boolean)
        : [];
    }
  );
}

function scheduleIntervals(event) {
  const schedule = event.schedule;
  if (schedule?.enabled === false) return [];
  const rate = typeof schedule === 'string' ? schedule : schedule?.rate;
  return (Array.isArray(rate) ? rate : [rate])
    .map(intervalSeconds)
    .filter(Number.isFinite);
}

function operationsFor(name) {
  if (name === 'nftsLoop')
    return {
      operations: ['discovery', 'refresh', 'audit', 'publication'],
      operationBudgets: {
        refresh: { freshSeconds: 1620 },
        audit: { freshSeconds: 4620 }
      }
    };
  if (name === 'nextgenContractLoop')
    return {
      operations: ['indexing', 'recalculation'],
      optionalOperations: ['recalculation']
    };
  if (name === 'nftLinkMediaPreviewLoop')
    return {
      operations: ['processing'],
      idleOperations: ['processing'],
      oldestAdvanceIsProgress: false
    };
  if (name === 'waveScoreRefreshLoop')
    return {
      operations: ['dirty_refresh', 'full_refresh'],
      optionalOperations: ['full_refresh']
    };
  if (name === 'delegationsLoop')
    return {
      operations: ['indexing', 'recalculation'],
      optionalOperations: ['recalculation']
    };
  if (name === 'waveDecisionExecutionLoop')
    return {
      operations: ['decisions', 'native_execution', 'publication'],
      operationBudgets: {
        decisions: { delaySeconds: 120, freshSeconds: 120 },
        publication: { delaySeconds: 600, stallSeconds: 3900 }
      }
    };
  return { operations: ['processing'] };
}

function functionPolicy(config, fn) {
  const events = fn.events ?? [];
  const intervals = [
    ...events.flatMap(scheduleIntervals),
    ...queueSchedules(config, events)
      .map(intervalSeconds)
      .filter(Number.isFinite)
  ];
  const interval = intervals.length ? Math.min(...intervals) : undefined;
  const concurrency =
    fn.reservedConcurrency ?? config.provider?.reservedConcurrency;
  const timeout = fn.timeout ?? config.provider?.timeout ?? 6;
  return {
    service: fn.name,
    ...(interval ? { intervalSeconds: interval } : {}),
    ...(typeof concurrency === 'number'
      ? { reservedConcurrency: concurrency }
      : {}),
    expectedOverlap:
      interval !== undefined && interval <= 300 && concurrency === 1,
    delaySeconds: Math.max(600, (interval ?? 60) * 2),
    stallSeconds: Math.max(timeout + 300, (interval ?? 60) * 3),
    freshSeconds: Math.max(timeout + 120, (interval ?? 60) * 2),
    ...operationsFor(fn.name)
  };
}

export function policiesFromConfig(service, config) {
  return Object.values(config.functions ?? {})
    .filter(
      (fn) =>
        service.verification_targets.includes(fn.name) &&
        (fn.events ?? []).some(
          (event) =>
            event.sqs || (event.schedule && event.schedule.enabled !== false)
        )
    )
    .map((fn) => functionPolicy(config, fn));
}

export async function loopPolicies(catalog, environment) {
  const services = catalog.services.filter(
    (service) =>
      service.allowed_environments.includes(environment) &&
      service.deploy_adapter === 'serverless'
  );
  const policies = await Promise.all(
    services.map(async (service) => {
      try {
        const file = new URL(`src/${service.name}/serverless.yaml`, root);
        const doc = parseDocument(await readFile(file, 'utf8'), {
          customTags: tags
        });
        if (doc.errors.length)
          throw new AggregateError(doc.errors, 'Invalid loop configuration');
        return policiesFromConfig(service, doc.toJS());
      } catch (cause) {
        throw new Error(`Unable to derive loop policy: ${service.name}`, {
          cause
        });
      }
    })
  );
  return policies.flat().sort((a, b) => a.service.localeCompare(b.service));
}
