import { z } from 'zod';
import { normalizeCounter } from './membership-validation';

export const MEMBERSHIP_RUNTIME_STATUS_ACTION = 'membership_runtime_status_v1';
export const MEMBERSHIP_FIXTURE_DATABASE = 'membership_runtime_drill_v1';
export const MEMBERSHIP_FIXTURE_CONTROL_TABLE =
  'membership_runtime_fixture_control';
export const MEMBERSHIP_FIXTURE_OWNER = 'membership-runtime-drill-v1';
export const MEMBERSHIP_FIXTURE_PROFILES = [
  'membership-drill-long-v1',
  'membership-drill-transport-v1',
  'membership-drill-expiry-v1'
] as const;
export const MEMBERSHIP_FIXTURE_GROUPS = Object.freeze(
  Array.from(
    { length: 36 },
    (_, index) => `membership-drill-group-${String(index + 1).padStart(3, '0')}`
  )
);

export interface MembershipRuntimeEnvironment {
  readonly stage: string | undefined;
  readonly region: string | undefined;
  readonly mode: string | undefined;
  readonly queue_arn: string | undefined;
  readonly queue_url: string | undefined;
}
export interface MembershipRuntimeDeployment {
  readonly stage: 'staging' | 'prod';
  readonly region: 'eu-west-1' | 'us-east-1';
  readonly mode: 'inactive' | 'staging-fixture-v1';
  readonly queue_arn: string;
  readonly queue_url: string;
}

/** Only deployment-owned values captured before shared secret loading are accepted. */
export function validateMembershipRuntimeDeployment(
  input: MembershipRuntimeEnvironment
): MembershipRuntimeDeployment {
  const { stage, region, mode, queue_arn, queue_url } = input;
  if (
    !(
      (stage === 'staging' && region === 'eu-west-1') ||
      (stage === 'prod' && region === 'us-east-1')
    ) ||
    (mode !== 'inactive' && mode !== 'staging-fixture-v1') ||
    (mode === 'staging-fixture-v1' && stage !== 'staging')
  )
    throw new Error('Invalid membership runtime deployment');
  const queueName = `membership-refresh-work-${stage}-v1`;
  if (
    queue_arn !== `arn:aws:sqs:${region}:987989283142:${queueName}` ||
    queue_url !==
      `https://sqs.${region}.amazonaws.com/987989283142/${queueName}`
  )
    throw new Error('Invalid membership runtime queue identity');
  return Object.freeze({ stage, region, mode, queue_arn, queue_url });
}

export function isMembershipRuntimeStatus(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    !Array.isArray(event) &&
    Object.keys(event).length === 1 &&
    Object.prototype.hasOwnProperty.call(event, 'operator_action') &&
    (event as { operator_action?: unknown }).operator_action ===
      MEMBERSHIP_RUNTIME_STATUS_ACTION
  );
}

const counter = z.string().refine((value) => {
  try {
    return normalizeCounter(value) === value;
  } catch {
    return false;
  }
});
const target = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('PROFILE'),
      target_id: z.enum(MEMBERSHIP_FIXTURE_PROFILES)
    })
    .strict(),
  z.object({ scope: z.literal('FULL'), target_id: z.literal('*') }).strict(),
  z
    .object({
      scope: z.literal('GROUP'),
      target_id: z
        .string()
        .refine((id) => MEMBERSHIP_FIXTURE_GROUPS.includes(id))
    })
    .strict()
]);
const hint = z
  .object({
    protocol_version: z.literal(1),
    target,
    delivery: z
      .object({ requested_version: counter, reserved_until_millis: counter })
      .strict()
  })
  .strict();
export type MembershipRuntimeHint = z.infer<typeof hint>;
const envelope = z
  .object({
    Records: z
      .array(
        z
          .object({
            eventSource: z.literal('aws:sqs'),
            eventSourceARN: z.string().max(256),
            awsRegion: z.string().max(32),
            messageId: z.string().uuid(),
            body: z
              .string()
              .refine((value) => Buffer.byteLength(value) <= 2048),
            attributes: z
              .object({
                ApproximateReceiveCount: z.string().regex(/^[1-9]\d{0,5}$/)
              })
              .passthrough()
          })
          .passthrough()
      )
      .length(1)
  })
  .strict();

export function parseMembershipWorkerDelivery(
  event: unknown,
  deployment: MembershipRuntimeDeployment
) {
  if (deployment.mode !== 'staging-fixture-v1') {
    throw new Error('Membership runtime is inactive');
  }
  const parsed = envelope.safeParse(event);
  if (!parsed.success)
    throw new Error('Unsupported membership worker envelope');
  const record = parsed.data.Records[0];
  if (
    record.eventSourceARN !== deployment.queue_arn ||
    record.awsRegion !== deployment.region
  ) {
    throw new Error('Membership worker delivery came from an unexpected queue');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(record.body);
  } catch {
    throw new Error('Invalid membership worker hint JSON');
  }
  const body = hint.safeParse(decoded);
  if (!body.success) throw new Error('Unsupported membership fixture hint');
  return {
    hint: body.data,
    message_id: record.messageId,
    receive_count: Number(record.attributes.ApproximateReceiveCount)
  };
}
