import test from 'node:test';
import assert from 'node:assert/strict';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { SNSEvent } from 'aws-lambda';
import { hash } from './contract.js';
import { fallbackNotice } from './fallback.js';
import { forwardFallback } from './handlers.js';

const name = 'seize-monitoring-prod-NormalCollectorErrors-ABC123';
const body = {
  AlarmName: name,
  AlarmArn: `arn:aws:cloudwatch:eu-west-1:123456789012:alarm:${name}`,
  NewStateValue: 'ALARM',
  StateChangeTime: '2026-11-09T07:31:07.220+0000',
  AlarmDescription: 'PRIVATE description',
  NewStateReason: 'PRIVATE reason',
  Trigger: { Dimensions: [{ value: 'PRIVATE dimensions' }] }
};
const notice = {
  MessageId: 'incoming-id',
  TopicArn:
    'arn:aws:sns:eu-west-1:123456789012:seize-monitoring-prod-FallbackTopic-ABC123',
  Timestamp: '2026-11-09T07:31:08Z',
  Message: JSON.stringify(body)
} as SNSEvent['Records'][number]['Sns'];

test('owned alarm emails and diagnostics carry safe alarm context and the same searchable reference', () => {
  const result = fallbackNotice(notice);
  assert.equal(result.context.alarm, name);
  assert.equal(result.context.state, 'ALARM');
  assert.equal(result.context.environment, 'prod');
  assert.equal(result.context.eventTime, '2026-11-09T07:31:07.220Z');
  assert.equal(result.context.reference, hash(notice.MessageId));
  assert.ok(result.message.includes(name));
  assert.ok(result.message.includes(result.context.reference));
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

for (const changed of [
  { AlarmArn: body.AlarmArn.replace('123456789012', '999999999999') },
  { AlarmArn: body.AlarmArn.replace('eu-west-1', 'us-east-1') },
  { AlarmName: 'PRIVATE arbitrary alarm' },
  { AlarmName: 'seize-monitoring-staging-Errors-ABC123' },
  { NewStateValue: 'PRIVATE state' }
]) {
  test(`unbound alarm metadata is omitted: ${Object.keys(changed).join(',')}`, () => {
    const result = fallbackNotice({
      ...notice,
      Message: JSON.stringify({ ...body, ...changed })
    });
    assert.equal(result.context.alarm, undefined);
    assert.equal(result.context.state, undefined);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  });
}

for (const message of ['PRIVATE malformed', '{', 'PRIVATE'.repeat(3000)]) {
  test(`unknown or oversized bodies retain generic fallback (${message.length} bytes)`, () => {
    const result = fallbackNotice({ ...notice, Message: message });
    assert.equal(result.context.alarm, undefined);
    assert.ok(result.message.includes(hash(notice.MessageId)));
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  });
}

test('only fixed internal fallback codes are copied', () => {
  const result = fallbackNotice({
    ...notice,
    Message: 'Monitoring event RETRIES_EXHAUSTED. PRIVATE body'
  });
  assert.equal(result.context.eventCode, 'RETRIES_EXHAUSTED');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(
    fallbackNotice({ ...notice, Message: 'Monitoring event PRIVATE.' }).context
      .eventCode,
    undefined
  );
});

test('unknown topic and invalid timestamps cannot inject email context', () => {
  const result = fallbackNotice({
    ...notice,
    TopicArn: 'PRIVATE topic',
    Timestamp: 'PRIVATE time'
  });
  assert.equal(result.context.environment, 'unknown');
  assert.equal(result.context.eventTime, undefined);
  assert.equal(result.context.alarm, undefined);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('the forwarder publishes once, logs the same reference, and preserves publish failure for retry', async (t) => {
  const original = process.env.FALLBACK_TARGET_TOPIC_ARN;
  process.env.FALLBACK_TARGET_TOPIC_ARN =
    'arn:aws:sns:us-east-1:999999999999:cloudwatch-alarms';
  t.after(() => {
    if (original === undefined) delete process.env.FALLBACK_TARGET_TOPIC_ARN;
    else process.env.FALLBACK_TARGET_TOPIC_ARN = original;
  });
  const logs: Record<string, unknown>[] = [];
  t.mock.method(console, 'log', (line: string) => logs.push(JSON.parse(line)));
  const publish = t.mock.method(
    SNSClient.prototype,
    'send',
    async (command: PublishCommand) => {
      assert.equal(
        command.input.TopicArn,
        process.env.FALLBACK_TARGET_TOPIC_ARN
      );
      assert.ok(command.input.Message?.includes(hash(notice.MessageId)));
      assert.equal(JSON.stringify(command.input).includes('PRIVATE'), false);
      return { MessageId: 'outgoing-id' };
    }
  );
  const event = { Records: [{ Sns: notice }] } as SNSEvent;
  await forwardFallback(event);
  assert.equal(publish.mock.callCount(), 1);
  assert.deepEqual(
    logs.map((row) => row.phase),
    ['PUBLISHING', 'PUBLISHED']
  );
  assert.ok(logs.every((row) => row.reference === hash(notice.MessageId)));
  const failure = new Error('SNS unavailable');
  publish.mock.mockImplementation(async () => {
    throw failure;
  });
  await assert.rejects(
    () => forwardFallback(event),
    (error) => error === failure
  );
  assert.equal(logs.at(-1)?.phase, 'PUBLISHING');
});
