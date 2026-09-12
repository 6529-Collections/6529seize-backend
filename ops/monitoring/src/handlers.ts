import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  EventBridgeClient,
  PutEventsCommand
} from '@aws-sdk/client-eventbridge';
import {
  CloudWatchClient,
  PutMetricDataCommand
} from '@aws-sdk/client-cloudwatch';
import { ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  CloudWatchLogsEvent,
  Context,
  EventBridgeEvent,
  SQSEvent,
  SQSBatchResponse,
  SNSEvent
} from 'aws-lambda';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import {
  EVENT_TYPE,
  Alert,
  Environment,
  hash,
  parseAlert,
  record,
  token
} from './contract.js';
import {
  admit,
  archive,
  backup,
  enqueue,
  put,
  read,
  secret,
  setting,
  sqs,
  store,
  normalDeliverySlot
} from './aws.js';
import { parseWork, processWork, Work } from './pipeline.js';
import { deliver, DeliveryError, webhookUrl } from './webhook.js';
import { sentryAlert, verifySignature } from './sentry.js';

const environment = (): Environment => {
  const value = setting('ENVIRONMENT');
  if (value !== 'prod' && value !== 'staging')
    throw new Error('INVALID_ENVIRONMENT');
  return value;
};
const list = (name: string): string[] =>
  (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

async function accept(alert: Alert, critical: boolean): Promise<void> {
  if (!critical && !(await admit(alert))) {
    await archive({ kind: 'alert', alert }, 'SOURCE_ADMISSION_BUDGET');
    metric('AdmissionOverflow', 1);
    // This event is durably retained; never acknowledge a dropped event as delivered.
    return;
  }
  await enqueue({ kind: 'alert', alert }, critical);
}

function metric(name: string, value: number): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: '6529/OperationalMonitoring',
            Dimensions: [['Environment']],
            Metrics: [{ Name: name, Unit: 'Count' }]
          }
        ]
      },
      Environment: environment(),
      [name]: value
    })
  );
}
export async function ingress(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  if (
    event.rawPath !== '/sentry' ||
    event.requestContext.http.method !== 'POST'
  )
    return { statusCode: 404 };
  const body = Buffer.from(
    event.body ?? '',
    event.isBase64Encoded ? 'base64' : 'utf8'
  );
  if (body.length > 262144) return { statusCode: 413 };
  const headers = Object.fromEntries(
    Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  const signature = headers['sentry-hook-signature'] ?? '';
  if (
    !verifySignature(
      body,
      signature,
      await secret(setting('SENTRY_SECRET_ARN'))
    )
  )
    return { statusCode: 401 };
  let alert: Alert | null;
  try {
    alert = sentryAlert(
      JSON.parse(body.toString('utf8')),
      environment(),
      list('SENTRY_PROJECTS')
    );
  } catch {
    return { statusCode: 400 };
  }
  if (alert) await accept(alert, false);
  return { statusCode: 202 }; // Only after durable queue/archive acceptance.
}

export async function health(): Promise<APIGatewayProxyResultV2> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const states = await Promise.all(
      ['normal', 'critical', 'delivery'].map((lane) => read(`health:${lane}`))
    );
    const healthy = states.every(
      (state) => typeof state?.seenAt === 'number' && now - state.seenAt < 180
    );
    return {
      statusCode: healthy ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({ status: healthy ? 'ok' : 'degraded' })
    };
  } catch {
    return { statusCode: 503, body: '{"status":"degraded"}' };
  }
}

export async function collect(
  event: EventBridgeEvent<string, unknown>
): Promise<void> {
  if (!list('SOURCE_ACCOUNTS').includes(event.account))
    throw new Error('UNAPPROVED_SOURCE');
  if (event.source === '6529.ops' && event['detail-type'] === EVENT_TYPE) {
    const alert = parseAlert(event.detail);
    if (
      alert.environment !== environment() ||
      !list('ALLOWED_SERVICES').includes(alert.service)
    ) {
      throw new Error('UNAPPROVED_SERVICE');
    }
    // Application credentials can never inject the protected alarm/uptime lane.
    alert.severity = 'error';
    if (!['APPLICATION_ERROR', 'LAMBDA_FAILURE'].includes(alert.code))
      throw new Error('UNAPPROVED_CODE');
    await accept(alert, false);
    return;
  }
  if (
    event.source !== 'aws.cloudwatch' ||
    event['detail-type'] !== 'CloudWatch Alarm State Change'
  ) {
    throw new Error('UNAPPROVED_EVENT_TYPE');
  }
  if (event.region !== setting('SOURCE_REGION'))
    throw new Error('UNAPPROVED_SOURCE_REGION');
  const detail = record(event.detail);
  const state = record(detail.state).value;
  if (state !== 'ALARM' && state !== 'OK') return;
  if (state === 'OK' && record(detail.previousState).value !== 'ALARM') return;
  const configuration = record(detail.configuration);
  const metrics = Array.isArray(configuration.metrics)
    ? configuration.metrics
    : [];
  const dimensions = record(
    record(record(record(metrics[0]).metricStat).metric).dimensions
  );
  const service = token(dimensions.FunctionName) ?? 'platform';
  const alarmIdentity =
    typeof detail.alarmName === 'string' ? detail.alarmName : event.id;
  await accept(
    {
      _type: EVENT_TYPE,
      eventId: `alarm:${event.id}`,
      occurredAt: event.time,
      environment: environment(),
      service,
      severity: state === 'OK' ? 'recovery' : 'critical',
      code: state === 'OK' ? 'PLATFORM_RECOVERY' : 'PLATFORM_ALARM',
      fingerprint: hash(
        `${event.account}:${event.region}:${alarmIdentity}:${state}`
      )
    },
    true
  );
}

export async function logs(event: CloudWatchLogsEvent): Promise<void> {
  const alerts = logAlerts(
    event.awslogs.data,
    setting('SOURCE_ACCOUNT'),
    list('ALLOWED_LOG_GROUPS'),
    environment()
  );
  const bus = setting('MONITOR_EVENT_BUS_ARN');
  const client = new EventBridgeClient({
    region: bus.split(':')[3],
    maxAttempts: 3
  });
  const entries = alerts.map((alert) => ({
    Source: '6529.ops',
    DetailType: EVENT_TYPE,
    EventBusName: bus,
    Detail: JSON.stringify(alert)
  }));
  for (let i = 0; i < entries.length; i += 10) {
    const response = await client.send(
      new PutEventsCommand({ Entries: entries.slice(i, i + 10) })
    );
    if (response.FailedEntryCount) throw new Error('EVENT_FORWARD_FAILED');
  }
}

export function logAlerts(
  encoded: string,
  account: string,
  logGroups: string[],
  env: Environment
): Alert[] {
  const payload = record(
    JSON.parse(
      gunzipSync(Buffer.from(encoded, 'base64'), {
        maxOutputLength: 4 * 1024 * 1024
      }).toString('utf8')
    )
  );
  if (payload.messageType === 'CONTROL_MESSAGE') return [];
  if (
    payload.owner !== account ||
    typeof payload.logGroup !== 'string' ||
    !logGroups.includes(payload.logGroup)
  )
    throw new Error('UNAPPROVED_LOG_SOURCE');
  const service = payload.logGroup.replace(/^\/aws\/lambda\//, '');
  const rows = Array.isArray(payload.logEvents) ? payload.logEvents : [];
  const alerts: Alert[] = [];
  for (const raw of rows) {
    const row = record(raw);
    let alert: Alert;
    try {
      const decoded: unknown = JSON.parse(String(row.message));
      const nested = record(decoded).message;
      alert = parseAlert(
        typeof nested === 'string' ? JSON.parse(nested) : decoded
      );
    } catch {
      continue;
    }
    // AWS log metadata, not text supplied by application callers, binds the service and identity.
    alert.service = service;
    alert.eventId = `log:${hash(`${payload.owner}:${payload.logGroup}:${payload.logStream}:${row.id}`)}`;
    alert.environment = env;
    alert.severity = 'error';
    if (!['APPLICATION_ERROR', 'LAMBDA_FAILURE'].includes(alert.code)) continue;
    alerts.push(alert);
  }
  return alerts;
}

export async function dispatch(
  event: SQSEvent,
  context: Context
): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const lane = setting('LANE');
  for (const row of event.Records) {
    try {
      let work: Work;
      try {
        work = parseWork(JSON.parse(row.body));
      } catch {
        // Do not persist malformed, potentially sensitive raw payloads.
        await archive(
          { sourceMessageHash: hash(row.body), messageId: row.messageId },
          'INVALID_WORK'
        );
        await backup('INVALID_WORK');
        continue;
      }
      if (work.kind === 'heartbeat' && work.lane !== lane)
        throw new Error('WRONG_LANE');
      if (
        work.kind === 'alert' &&
        (work.alert.severity === 'error') !== (lane === 'normal')
      ) {
        throw new Error('WRONG_LANE');
      }
      await processWork(
        work,
        `${context.awsRequestId}:${row.messageId}`,
        store,
        {
          schedule: (item, delay) => enqueue(item, false, delay),
          deliver: async (payload) => {
            if (lane === 'normal') await normalDeliverySlot();
            return deliver(
              await secret(setting('WEBHOOK_SECRET_ARN')),
              payload
            );
          },
          archive: async (item, reason) => {
            await archive(item, reason);
            await backup(reason);
          }
        }
      );
    } catch (error) {
      // Log codes only; no SDK exception can leak a webhook URL or vendor response.
      if (!(error instanceof DeliveryError && error.deferred)) {
        console.error(
          JSON.stringify({
            code: 'DELIVERY_FAILED',
            lane,
            messageId: row.messageId
          })
        );
        metric('DeliveryFailures', 1);
      }
      if (error instanceof DeliveryError && error.retryAfterSeconds > 0) {
        await sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: setting(
                lane === 'critical' ? 'CRITICAL_QUEUE_URL' : 'NORMAL_QUEUE_URL'
              ),
              ReceiptHandle: row.receiptHandle,
              VisibilityTimeout: error.retryAfterSeconds
            })
          )
          .catch(() => undefined);
      }
      batchItemFailures.push({ itemIdentifier: row.messageId });
    }
  }
  return { batchItemFailures };
}

export async function archiveDeadLetters(
  event: SQSEvent
): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const row of event.Records) {
    try {
      let work: unknown;
      try {
        work = parseWork(JSON.parse(row.body));
      } catch {
        try {
          const value = record(JSON.parse(row.body));
          const event = record(value.requestPayload ?? value);
          work = { kind: 'alert', alert: parseAlert(event.detail) };
        } catch {
          work = { sourceMessageHash: hash(row.body) };
        }
      }
      await archive(work, 'RETRIES_EXHAUSTED');
      await backup('RETRIES_EXHAUSTED');
    } catch {
      batchItemFailures.push({ itemIdentifier: row.messageId });
    }
  }
  return { batchItemFailures };
}

export function probeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_PROBE_TARGET');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
    url.hostname.endsWith('.local')
  ) {
    throw new Error('INVALID_PROBE_TARGET');
  }
  return url;
}
export async function probe(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const metricData = [];
  for (const lane of ['normal', 'critical'] as const) {
    const health = await read(`health:${lane}`);
    const age =
      typeof health?.seenAt === 'number'
        ? Math.max(0, now - health.seenAt)
        : 9999;
    metricData.push({
      MetricName: 'HeartbeatAge',
      Value: age,
      Unit: 'Seconds' as const,
      Dimensions: [
        { Name: 'Environment', Value: environment() },
        { Name: 'Lane', Value: lane }
      ]
    });
    await enqueue(
      {
        kind: 'heartbeat',
        eventId: `heartbeat:${lane}:${randomUUID()}`,
        lane,
        emittedAt: now
      },
      lane === 'critical'
    );
  }
  const targets = JSON.parse(process.env.PROBE_TARGETS ?? '[]') as {
    name: string;
    url: string;
    status?: number;
  }[];
  for (const target of targets.slice(0, 10)) {
    const name = token(target.name, 80);
    if (!name) throw new Error('INVALID_PROBE_NAME');
    const url = probeUrl(target.url);
    let healthy = false;
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      });
      healthy = response.status === (target.status ?? 200);
      await response.body?.cancel();
    } catch {
      /* failure is recorded below */
    }
    const previous = await read(`probe:${name}`);
    const failures = healthy ? 0 : Number(previous?.failures ?? 0) + 1;
    const down = failures >= 2;
    const wasDown = previous?.down === true;
    if (down !== wasDown && (down || healthy)) {
      await enqueue(
        {
          kind: 'alert',
          alert: {
            _type: EVENT_TYPE,
            eventId: `uptime:${name}:${now}`,
            occurredAt: new Date().toISOString(),
            environment: environment(),
            service: `uptime.${name}`,
            severity: down ? 'critical' : 'recovery',
            code: down ? 'UPTIME_FAILURE' : 'UPTIME_RECOVERY',
            fingerprint: hash(`uptime:${name}:${down}`)
          }
        },
        true
      );
    }
    await put(`probe:${name}`, {
      failures,
      down: down || (!healthy && wasDown),
      checkedAt: now
    });
  }
  await new CloudWatchClient({ maxAttempts: 3 }).send(
    new PutMetricDataCommand({
      Namespace: '6529/OperationalMonitoring',
      MetricData: metricData
    })
  );
  // Credential/endpoint health does not send a Discord message or expose its response.
  const webhook = new URL(
    webhookUrl(await secret(setting('WEBHOOK_SECRET_ARN')))
  );
  webhook.search = '';
  const response = await fetch(webhook, {
    redirect: 'error',
    signal: AbortSignal.timeout(8000)
  }).catch(() => {
    throw new Error('WEBHOOK_HEALTH_FAILED');
  });
  const webhookHealthy = response.ok;
  await response.body?.cancel();
  if (!webhookHealthy) throw new Error('WEBHOOK_HEALTH_FAILED');
  await put('health:delivery', { seenAt: now });
  const checkInArn = process.env.CHECKIN_SECRET_ARN;
  if (checkInArn && metricData.every((metric) => metric.Value < 180)) {
    // Optional dead-man switch owned outside AWS. Never check in from a broken queue pipeline.
    const checkIn = probeUrl(await secret(checkInArn));
    const result = await fetch(checkIn, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    }).catch(() => {
      throw new Error('EXTERNAL_CHECKIN_FAILED');
    });
    const ok = result.ok;
    await result.body?.cancel();
    if (!ok) throw new Error('EXTERNAL_CHECKIN_FAILED');
  }
}

export async function forwardFallback(event: SNSEvent): Promise<void> {
  const topic = setting('FALLBACK_TARGET_TOPIC_ARN');
  // This temporary fallback is intentionally independent of Discord but still needs the source account.
  const client = new SNSClient({ region: topic.split(':')[3], maxAttempts: 3 });
  for (const row of event.Records) {
    await client.send(
      new PublishCommand({
        TopicArn: topic,
        Subject: '6529 monitoring needs attention',
        Message: `The independent monitoring pipeline needs attention. Reference ${hash(row.Sns.MessageId)}. Inspect its CloudWatch alarms, queues and archive.`
      })
    );
  }
}
