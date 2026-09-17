import {
  isMembershipRuntimeStatus,
  MEMBERSHIP_FIXTURE_GROUPS,
  MEMBERSHIP_FIXTURE_PROFILES,
  MEMBERSHIP_RUNTIME_STATUS_ACTION,
  parseMembershipWorkerDelivery,
  validateMembershipRuntimeDeployment
} from './membership-runtime-policy';

const staging = {
  stage: 'staging',
  region: 'eu-west-1',
  mode: 'staging-fixture-v1',
  queue_arn:
    'arn:aws:sqs:eu-west-1:987989283142:membership-refresh-work-staging-v1',
  queue_url:
    'https://sqs.eu-west-1.amazonaws.com/987989283142/membership-refresh-work-staging-v1'
};
const runtime = validateMembershipRuntimeDeployment(staging);
const validHint = {
  protocol_version: 1,
  target: { scope: 'PROFILE', target_id: MEMBERSHIP_FIXTURE_PROFILES[0] },
  delivery: {
    requested_version: '9007199254740993',
    reserved_until_millis: '9223372036854775807'
  }
};
const record = () => ({
  eventSource: 'aws:sqs',
  eventSourceARN: staging.queue_arn,
  awsRegion: staging.region,
  messageId: '019946b3-4180-7000-8000-000000000001',
  body: JSON.stringify(validHint),
  attributes: { ApproximateReceiveCount: '1' }
});
const parse = (body: unknown) =>
  parseMembershipWorkerDelivery(
    { Records: [{ ...record(), body: JSON.stringify(body) }] },
    runtime
  );

describe('closed membership runtime deployment and delivery policy', () => {
  it('pins stage, real region, account, queue name and URL together', () => {
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(
      validateMembershipRuntimeDeployment({
        stage: 'prod',
        region: 'us-east-1',
        mode: 'inactive',
        queue_arn:
          'arn:aws:sqs:us-east-1:987989283142:membership-refresh-work-prod-v1',
        queue_url:
          'https://sqs.us-east-1.amazonaws.com/987989283142/membership-refresh-work-prod-v1'
      }).mode
    ).toBe('inactive');
  });
  it.each([
    { stage: undefined },
    { mode: undefined },
    { stage: 'production' },
    { region: 'us-east-1' },
    { mode: 'active' },
    { queue_arn: staging.queue_arn.replace('987989283142', '111111111111') },
    { queue_url: staging.queue_url + '/' },
    { queue_url: 'https://example.test/queue' },
    { stage: 'prod', region: 'us-east-1' }
  ])('rejects inconsistent deployment %j', (change) => {
    expect(() =>
      validateMembershipRuntimeDeployment({ ...staging, ...change })
    ).toThrow('Invalid membership runtime');
  });
  it('recognizes only the single own status action', () => {
    expect(
      isMembershipRuntimeStatus({
        operator_action: MEMBERSHIP_RUNTIME_STATUS_ACTION
      })
    ).toBe(true);
    for (const event of [
      null,
      [],
      {},
      MEMBERSHIP_RUNTIME_STATUS_ACTION,
      { operator_action: 'status' },
      { operator_action: MEMBERSHIP_RUNTIME_STATUS_ACTION, target: '*' },
      Object.assign(
        Object.create({ operator_action: MEMBERSHIP_RUNTIME_STATUS_ACTION }),
        { unexpected: true }
      )
    ])
      expect(isMembershipRuntimeStatus(event)).toBe(false);
  });
  it('rejects all delivery work while inactive', () => {
    expect(() =>
      parseMembershipWorkerDelivery(
        { Records: [record()] },
        { ...runtime, mode: 'inactive' }
      )
    ).toThrow('inactive');
  });
  it('preserves exact BIGINT counters and actual SQS correlation', () => {
    const parsed = parseMembershipWorkerDelivery(
      {
        Records: [
          {
            ...record(),
            receiptHandle: 'opaque',
            attributes: {
              ApproximateReceiveCount: '999999',
              SentTimestamp: '123'
            }
          }
        ]
      },
      runtime
    );
    expect(parsed).toEqual({
      hint: validHint,
      message_id: record().messageId,
      receive_count: 999999
    });
  });
  it('accepts canonical ordinary targets only in staging controlled mode', () => {
    const controlled = validateMembershipRuntimeDeployment({
      ...staging,
      mode: 'staging-controlled-v1'
    });
    const real = {
      ...validHint,
      target: { scope: 'PROFILE', target_id: 'real-profile' }
    };
    expect(
      parseMembershipWorkerDelivery(
        { Records: [{ ...record(), body: JSON.stringify(real) }] },
        controlled
      ).hint.target
    ).toEqual(real.target);
    expect(() =>
      parseMembershipWorkerDelivery(
        { Records: [{ ...record(), body: JSON.stringify(real) }] },
        runtime
      )
    ).toThrow('fixture hint');
    expect(() =>
      parseMembershipWorkerDelivery(
        {
          Records: [
            {
              ...record(),
              body: JSON.stringify({
                ...real,
                target: { ...real.target, force: true }
              })
            }
          ]
        },
        controlled
      )
    ).toThrow('controlled hint');
  });
  it('accepts exactly the three profile, 36 group, and FULL fixture targets', () => {
    expect(MEMBERSHIP_FIXTURE_PROFILES).toHaveLength(3);
    expect(MEMBERSHIP_FIXTURE_GROUPS).toHaveLength(36);
    for (const target of [
      ...MEMBERSHIP_FIXTURE_PROFILES.map((target_id) => ({
        scope: 'PROFILE',
        target_id
      })),
      ...MEMBERSHIP_FIXTURE_GROUPS.map((target_id) => ({
        scope: 'GROUP',
        target_id
      })),
      { scope: 'FULL', target_id: '*' }
    ])
      expect(parse({ ...validHint, target }).hint.target).toEqual(target);
  });
  it.each([
    { scope: 'GLOBAL', target_id: '*' },
    { scope: 'PROFILE', target_id: 'real-profile' },
    { scope: 'GROUP', target_id: 'membership-drill-group-037' },
    { scope: 'FULL', target_id: 'other' },
    {
      scope: 'PROFILE',
      target_id: MEMBERSHIP_FIXTURE_PROFILES[0],
      lease_token: 'injected'
    }
  ])('rejects targets outside the fixture contract %j', (target) => {
    expect(() => parse({ ...validHint, target })).toThrow(
      'Unsupported membership fixture hint'
    );
  });
  it.each(['01', '-1', '1.0', '1e2', ' 1', '9223372036854775808', 1, null])(
    'rejects noncanonical or out-of-range counter %j',
    (value) => {
      for (const key of ['requested_version', 'reserved_until_millis'])
        expect(() =>
          parse({
            ...validHint,
            delivery: { ...validHint.delivery, [key]: value }
          })
        ).toThrow('Unsupported membership fixture hint');
    }
  );
  it('rejects caller authority, query instructions and extra hint keys', () => {
    for (const body of [
      { ...validHint, protocol_version: 2 },
      { ...validHint, sql: 'SELECT 1' },
      { ...validHint, database: 'app' },
      {
        ...validHint,
        delivery: { ...validHint.delivery, lease_token: 'token' }
      }
    ])
      expect(() => parse(body)).toThrow('Unsupported membership fixture hint');
  });
  it('enforces an inclusive 2048-byte bound before parsing, measured as UTF-8 bytes', () => {
    const body = JSON.stringify(validHint);
    const exact = body + ' '.repeat(2048 - Buffer.byteLength(body));
    expect(
      parseMembershipWorkerDelivery(
        { Records: [{ ...record(), body: exact }] },
        runtime
      ).hint
    ).toEqual(validHint);
    for (const oversized of [exact + ' ', exact.slice(0, -1) + 'é'])
      expect(() =>
        parseMembershipWorkerDelivery(
          { Records: [{ ...record(), body: oversized }] },
          runtime
        )
      ).toThrow('Unsupported membership worker envelope');
    expect(() =>
      parseMembershipWorkerDelivery(
        { Records: [{ ...record(), body: '{' }] },
        runtime
      )
    ).toThrow('hint JSON');
  });
  it.each(['0', '01', '1000000', '-1', '1.5', ' 1'])(
    'rejects invalid receive count %j',
    (count) => {
      expect(() =>
        parseMembershipWorkerDelivery(
          {
            Records: [
              { ...record(), attributes: { ApproximateReceiveCount: count } }
            ]
          },
          runtime
        )
      ).toThrow('envelope');
    }
  );
  it('requires one record from the exact queue and region', () => {
    for (const event of [
      { Records: [] },
      { Records: [record(), record()] },
      { Records: [record()], extra: true },
      { Records: [{ ...record(), messageId: 'not-a-uuid' }] },
      { Records: [{ ...record(), eventSource: 'aws:sns' }] }
    ])
      expect(() => parseMembershipWorkerDelivery(event, runtime)).toThrow(
        'envelope'
      );
    for (const change of [
      { eventSourceARN: staging.queue_arn + '-other' },
      { awsRegion: 'us-east-1' }
    ])
      expect(() =>
        parseMembershipWorkerDelivery(
          { Records: [{ ...record(), ...change }] },
          runtime
        )
      ).toThrow('unexpected queue');
  });
});
