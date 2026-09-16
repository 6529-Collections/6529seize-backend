import {
  parseMembershipScheduledEvent,
  validateMembershipDispatchDeployment
} from './membership-runtime-dispatch-policy';

const staging = {
  stage: 'staging',
  region: 'eu-west-1',
  mode: 'staging-fixture-v1',
  queue_arn:
    'arn:aws:sqs:eu-west-1:987989283142:membership-refresh-work-staging-v1',
  queue_url:
    'https://sqs.eu-west-1.amazonaws.com/987989283142/membership-refresh-work-staging-v1',
  rule_arn:
    'arn:aws:events:eu-west-1:987989283142:rule/membership-refresh-dispatch-staging-v1',
  schedule_enabled: 'true'
};
const now = Date.parse('2026-09-15T12:00:00Z');
const event = () => ({
  version: '0',
  id: '019946b3-4180-7000-8000-000000000001',
  'detail-type': 'Scheduled Event',
  source: 'aws.events',
  account: '987989283142',
  time: new Date(now).toISOString(),
  region: staging.region,
  resources: [staging.rule_arn],
  detail: {}
});

describe('membership dispatcher deployment and event boundary', () => {
  it('returns an immutable deployment with a real enabled boolean', () => {
    const deployment = validateMembershipDispatchDeployment(staging);
    expect(deployment).toMatchObject({
      schedule_enabled: true,
      rule_arn: staging.rule_arn
    });
    expect(Object.isFrozen(deployment)).toBe(true);
    expect(
      validateMembershipDispatchDeployment({
        ...staging,
        schedule_enabled: 'false'
      }).schedule_enabled
    ).toBe(false);
  });
  it.each([
    { stage: 'prod', region: 'us-east-1' },
    { region: 'us-east-1' },
    { mode: 'active' },
    { mode: 'inactive' },
    { queue_arn: staging.queue_arn + '-other' },
    { queue_url: staging.queue_url + '-other' },
    { rule_arn: staging.rule_arn + '-other' },
    { schedule_enabled: 'TRUE' },
    { schedule_enabled: '' },
    { schedule_enabled: undefined }
  ])('rejects unsupported deployment %j', (change) => {
    expect(() =>
      validateMembershipDispatchDeployment({ ...staging, ...change })
    ).toThrow();
  });
  it.each(['staging', 'prod'])(
    'accepts closed %s status configuration but refuses work',
    (stage) => {
      const region = stage === 'prod' ? 'us-east-1' : 'eu-west-1';
      const deployment = validateMembershipDispatchDeployment({
        stage,
        region,
        mode: 'inactive',
        schedule_enabled: 'false',
        queue_arn: `arn:aws:sqs:${region}:987989283142:membership-refresh-work-${stage}-v1`,
        queue_url: `https://sqs.${region}.amazonaws.com/987989283142/membership-refresh-work-${stage}-v1`,
        rule_arn: `arn:aws:events:${region}:987989283142:rule/membership-refresh-dispatch-${stage}-v1`
      });
      expect(() =>
        parseMembershipScheduledEvent(event(), deployment, now)
      ).toThrow('inactive');
    }
  );
  it('refuses a fixture tick while its schedule control is disabled', () => {
    expect(() =>
      parseMembershipScheduledEvent(
        event(),
        validateMembershipDispatchDeployment({
          ...staging,
          schedule_enabled: 'false'
        }),
        now
      )
    ).toThrow('inactive');
  });
  it.each([-30000, 0, 120000])(
    'accepts the exact time boundary at age %s ms',
    (age) => {
      const input = { ...event(), time: new Date(now - age).toISOString() };
      expect(
        parseMembershipScheduledEvent(
          input,
          validateMembershipDispatchDeployment(staging),
          now
        )
      ).toEqual({ event_id: input.id, scheduled_at: input.time });
    }
  );
  it.each([-30001, 120001])('rejects an out-of-bound tick age %s ms', (age) => {
    expect(() =>
      parseMembershipScheduledEvent(
        { ...event(), time: new Date(now - age).toISOString() },
        validateMembershipDispatchDeployment(staging),
        now
      )
    ).toThrow('expired');
  });
  it.each([
    { version: '1' },
    { id: 'operator-selected' },
    { source: 'manual' },
    { 'detail-type': 'other' },
    { account: '000000000000' },
    { time: 'invalid' },
    { region: 'us-east-1' },
    { resources: [] },
    { resources: [staging.rule_arn, staging.rule_arn] },
    { resources: [staging.rule_arn + '-other'] },
    { detail: { target: 'untrusted' } },
    { Records: [] }
  ])('rejects a nonnative or redirected scheduled event %j', (change) => {
    expect(() =>
      parseMembershipScheduledEvent(
        { ...event(), ...change },
        validateMembershipDispatchDeployment(staging),
        now
      )
    ).toThrow();
  });
});
