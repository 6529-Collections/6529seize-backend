import { createHash } from 'node:crypto';
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient
} from '@aws-sdk/client-scheduler';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  ForgeDelivery,
  forgeQueueUrl,
  wakeDropForge
} from '@/drop-forge/drop-forge.wake';
import { LaunchRecord, LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { launchGroup } from '@/drop-forge/drop-forge.groups';

const scheduler = new SchedulerClient({});
const sqs = new SQSClient({});
function scheduleName(id: string, key: string): string {
  return `forge-${createHash('sha256').update(`${id}:${key}`).digest('hex').slice(0, 48)}`;
}
function scheduleConfig() {
  const GroupName = process.env.DROP_FORGE_SCHEDULE_GROUP;
  const RoleArn = process.env.DROP_FORGE_SCHEDULER_ROLE_ARN;
  if (!GroupName || !RoleArn)
    throw new LaunchSafetyError('Launch schedule configuration is missing');
  return { GroupName, RoleArn };
}
export async function scheduleLaunch(
  delivery: ForgeDelivery,
  key: string,
  due: number,
  preparation = false
): Promise<void> {
  const seconds = due - Math.floor(Date.now() / 1000);
  if (seconds <= 60) {
    await wakeDropForge(delivery, preparation, Math.max(1, seconds));
    return;
  }
  const { GroupName, RoleArn } = scheduleConfig();
  const QueueUrl = await forgeQueueUrl(preparation);
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] })
  );
  const Arn = attributes.Attributes?.QueueArn;
  if (!Arn) throw new LaunchSafetyError('Launch queue ARN is unavailable');
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: scheduleName(delivery.id, key),
        GroupName,
        ScheduleExpression: `at(${new Date(due * 1000).toISOString().slice(0, 19)})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn,
          RoleArn,
          Input: JSON.stringify(delivery),
          RetryPolicy: {
            MaximumEventAgeInSeconds: 86400,
            MaximumRetryAttempts: 185
          },
          DeadLetterConfig: { Arn: `${Arn}-dlq` }
        }
      })
    );
  } catch (error) {
    // An immutable key prevents duplicate delivery from postponing the wake.
    if (!(error instanceof Error) || error.name !== 'ConflictException')
      throw error;
  }
}
export async function scheduleLaunchGroups(
  record: LaunchRecord,
  now: number
): Promise<void> {
  const groups = new Map<string, number>();
  for (const action of record.data.actions) {
    if (action.state !== 'CONFIRMED' && action.due > now)
      groups.set(
        launchGroup(action),
        Math.min(groups.get(launchGroup(action)) ?? Infinity, action.due)
      );
  }
  for (const [group, due] of Array.from(groups.entries())) {
    await scheduleLaunch(
      { id: record.id, revision: 0 },
      `${group}:${due}`,
      due
    );
  }
}
export async function launchWatchdog(
  delivery: ForgeDelivery,
  now: number,
  preparation = false
): Promise<string> {
  const key = `watchdog:${delivery.revision}:${delivery.step ?? 'launch'}:${now}`;
  await scheduleLaunch(delivery, key, now + 120, preparation);
  return key;
}
export async function removeLaunchWatchdog(
  id: string,
  key: string
): Promise<void> {
  try {
    await scheduler.send(
      new DeleteScheduleCommand({
        Name: scheduleName(id, key),
        GroupName: scheduleConfig().GroupName
      })
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException')
      throw error;
  }
}
export function launchNeedsContinuation(
  record: LaunchRecord,
  now: number,
  scheduled: boolean
): boolean {
  if (record.data.events.some((event) => !event.drop_id)) return true;
  if (
    record.data.manual_transactions?.some((proof) => proof.state === 'PENDING')
  )
    return true;
  if (
    record.data.actions.some((action) =>
      ['SIGNED', 'RESERVED'].includes(action.state)
    )
  )
    return true;
  return (
    scheduled &&
    ['ARMED', 'RUNNING'].includes(record.state) &&
    (record.data.actions.every((action) => action.state === 'CONFIRMED') ||
      record.data.actions.some(
        (action) =>
          action.state !== 'CONFIRMED' &&
          action.due <= now &&
          (!action.window_reported || action.late_delivery)
      ))
  );
}
export async function continueLaunch(
  record: LaunchRecord,
  now: number,
  scheduled: boolean
): Promise<void> {
  if (launchNeedsContinuation(record, now, scheduled))
    await wakeDropForge(
      { id: record.id, revision: record.revision },
      false,
      60
    );
}
