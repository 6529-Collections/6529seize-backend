import { z } from 'zod';
import {
  MembershipRuntimeEnvironment,
  validateMembershipRuntimeDeployment
} from './membership-runtime-policy';

export interface MembershipDispatchEnvironment extends MembershipRuntimeEnvironment {
  readonly rule_arn: string | undefined;
  readonly schedule_enabled: string | undefined;
}

export function validateMembershipDispatchDeployment(
  environment: MembershipDispatchEnvironment
) {
  const runtime = validateMembershipRuntimeDeployment(environment);
  const expected = `arn:aws:events:${runtime.region}:987989283142:rule/membership-refresh-dispatch-${runtime.stage}-v1`;
  if (
    environment.rule_arn !== expected ||
    !['true', 'false'].includes(environment.schedule_enabled ?? '') ||
    (environment.schedule_enabled === 'true' &&
      runtime.mode !== 'staging-fixture-v1')
  )
    throw new Error('Invalid membership dispatch deployment');
  return Object.freeze({
    ...runtime,
    rule_arn: expected,
    schedule_enabled: environment.schedule_enabled === 'true'
  });
}
export type MembershipDispatchDeployment = ReturnType<
  typeof validateMembershipDispatchDeployment
>;

const scheduledEvent = z
  .object({
    version: z.literal('0'),
    id: z.string().uuid(),
    'detail-type': z.literal('Scheduled Event'),
    source: z.literal('aws.events'),
    account: z.literal('987989283142'),
    time: z.string().datetime(),
    region: z.string().max(32),
    resources: z.array(z.string().max(256)).length(1),
    detail: z.object({}).strict()
  })
  .strict();

export function parseMembershipScheduledEvent(
  event: unknown,
  runtime: MembershipDispatchDeployment,
  nowMillis = Date.now()
) {
  if (runtime.mode !== 'staging-fixture-v1' || !runtime.schedule_enabled)
    throw new Error('Membership dispatch is inactive');
  const parsed = scheduledEvent.safeParse(event);
  if (!parsed.success)
    throw new Error('Unsupported membership scheduled event');
  const value = parsed.data;
  const age = nowMillis - Date.parse(value.time);
  if (
    value.region !== runtime.region ||
    value.resources[0] !== runtime.rule_arn ||
    !Number.isFinite(age) ||
    age < -30000 ||
    age > 120000
  )
    throw new Error('Unexpected or expired membership scheduled event');
  return { event_id: value.id, scheduled_at: value.time };
}
