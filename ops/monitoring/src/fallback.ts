import type { SNSEvent } from 'aws-lambda';
import { hash, record } from './contract.js';

type Notice = SNSEvent['Records'][number]['Sns'];
const alarmNames = {
  prod: /^seize-monitoring-prod-[A-Za-z0-9_-]{1,180}$/,
  staging: /^seize-monitoring-staging-[A-Za-z0-9_-]{1,180}$/
};
function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 50 &&
    Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}

export function fallbackNotice(notice: Notice) {
  // Delivery metadata binds the origin; never forward arbitrary SNS bodies.
  const topic =
    /^arn:aws:sns:([a-z0-9-]+):(\d{12}):seize-monitoring-(prod|staging)-FallbackTopic-[A-Za-z0-9]+$/.exec(
      notice.TopicArn
    );
  const environment = topic?.[3] ?? 'unknown';
  const reference = hash(notice.MessageId);
  let alarm: string | undefined;
  let state: string | undefined;
  let eventTime = timestamp(notice.Timestamp);
  let eventCode: string | undefined;
  if (topic && notice.Message.length <= 16384) {
    const alarmName =
      environment === 'prod' ? alarmNames.prod : alarmNames.staging;
    try {
      const body = record(JSON.parse(notice.Message));
      const name = body.AlarmName;
      if (
        typeof name === 'string' &&
        alarmName.test(name) &&
        body.AlarmArn ===
          `arn:aws:cloudwatch:${topic[1]}:${topic[2]}:alarm:${name}` &&
        ['ALARM', 'OK', 'INSUFFICIENT_DATA'].includes(
          String(body.NewStateValue)
        )
      ) {
        alarm = name;
        state = String(body.NewStateValue);
        eventTime = timestamp(body.StateChangeTime) ?? eventTime;
      }
    } catch {
      /* Non-alarm fallback notices retain the safe generic path. */
    }
    const code =
      /^Monitoring event (WEBHOOK_PERMANENT|INVALID_WORK|RETRIES_EXHAUSTED)\./.exec(
        notice.Message
      );
    eventCode = code?.[1];
  }
  const context = {
    reference,
    environment,
    alarm,
    state,
    eventTime,
    eventCode
  };
  return {
    context,
    subject: `6529 ${environment} monitoring needs attention`,
    message: [
      'The independent monitoring pipeline needs attention.',
      `Environment: ${environment}`,
      ...(alarm ? [`Alarm: ${alarm}`, `State: ${state}`] : []),
      ...(eventCode ? [`Event: ${eventCode}`] : []),
      ...(eventTime ? [`Event time: ${eventTime}`] : []),
      `Reference: ${reference}`,
      'Search the fallback-forwarder logs for this reference. Inspect monitoring CloudWatch alarms, queues and archive.'
    ].join('\n')
  };
}
