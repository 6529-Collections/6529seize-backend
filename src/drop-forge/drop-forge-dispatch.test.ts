import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  SchedulerClient
} from '@aws-sdk/client-scheduler';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  scheduleLaunchGroups,
  launchNeedsContinuation,
  launchWatchdog,
  removeLaunchWatchdog
} from '@/drop-forge/drop-forge.dispatch';
import { testLaunchData } from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import { parseForgeDelivery } from '@/drop-forge/drop-forge.wake';

let send: jest.SpyInstance;
const previous = { ...process.env };
const record = (): LaunchRecord => ({
  id: 'launch',
  revision: 4,
  state: 'RUNNING',
  error: null,
  updated_at: 0,
  data: testLaunchData()
});
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(0);
  process.env.DROP_FORGE_SCHEDULE_GROUP = 'drop-forge-staging';
  process.env.DROP_FORGE_SCHEDULER_ROLE_ARN =
    'arn:aws:iam::123456789012:role/scheduler';
  jest.spyOn(SQSClient.prototype, 'send').mockImplementation(async (command) =>
    command instanceof GetQueueAttributesCommand
      ? {
          Attributes: {
            QueueArn: 'arn:aws:sqs:eu-west-1:123456789012:drop-forge-launch'
          }
        }
      : { QueueUrl: 'queue' }
  );
  send = jest
    .spyOn(SchedulerClient.prototype, 'send')
    .mockResolvedValue({} as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...previous };
});
it('establishes future phase and research wakes independently of a failed opening action', async () => {
  const launch = record();
  launch.data.actions[0].state = 'FAILED';
  launch.data.actions[0].window_reported = true;
  await scheduleLaunchGroups(launch, 0);
  expect(send).toHaveBeenCalled();
  for (const [command] of send.mock.calls) {
    expect(command).toBeInstanceOf(CreateScheduleCommand);
    expect(command.input).toEqual(
      expect.objectContaining({
        ActionAfterCompletion: 'DELETE',
        FlexibleTimeWindow: { Mode: 'OFF' }
      })
    );
    expect(JSON.parse(command.input.Target.Input)).toEqual({
      id: launch.id,
      revision: 0
    });
    expect(command.input.Target.DeadLetterConfig.Arn).toMatch(/-dlq$/);
  }
});
it('keeps immutable schedules when duplicate delivery races, but surfaces other scheduling failures', async () => {
  send.mockRejectedValueOnce(
    Object.assign(new Error('exists'), { name: 'ConflictException' })
  );
  await expect(
    launchWatchdog({ id: 'launch', revision: 1 }, 1000)
  ).resolves.toBeDefined();
  send.mockRejectedValueOnce(new Error('denied'));
  await expect(
    launchWatchdog({ id: 'launch', revision: 1 }, 1001)
  ).rejects.toThrow('denied');
});
it('removes a watchdog only on normal completion and tolerates its already-firing race', async () => {
  const key = await launchWatchdog({ id: 'launch', revision: 1 }, 1000);
  send.mockRejectedValueOnce(
    Object.assign(new Error('fired'), { name: 'ResourceNotFoundException' })
  );
  await removeLaunchWatchdog('launch', key);
  expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteScheduleCommand);
});
it('gives concurrent deliveries independent watchdogs even at the same revision and time', async () => {
  const first = await launchWatchdog({ id: 'launch', revision: 1 }, 1000);
  const second = await launchWatchdog({ id: 'launch', revision: 1 }, 1000);
  expect(first).not.toBe(second);
  expect(send.mock.calls[0][0].input.Name).not.toBe(
    send.mock.calls[1][0].input.Name
  );
});
it('stops between future groups and after completion, but reconciles signed work beyond cutoffs and pause', () => {
  const launch = record();
  launch.data.events = [];
  for (const action of launch.data.actions) {
    action.due = 2000;
    action.deadline = 2100;
  }
  expect(launchNeedsContinuation(launch, 1000, true)).toBe(false);
  launch.data.actions[0].state = 'SIGNED';
  launch.state = 'PAUSED';
  expect(launchNeedsContinuation(launch, 3000, false)).toBe(true);
  launch.data.actions[0].state = 'CONFIRMED';
  launch.state = 'COMPLETED';
  expect(launchNeedsContinuation(launch, 3000, true)).toBe(false);
});
it('rejects malformed queue payloads rather than scanning unrelated jobs', () => {
  expect(() => parseForgeDelivery('{}')).toThrow('Invalid');
  expect(() => parseForgeDelivery('{"id":"x","revision":1,"step":-1}')).toThrow(
    'checkpoint'
  );
  expect(parseForgeDelivery('{"id":"x","revision":2}')).toEqual({
    id: 'x',
    revision: 2
  });
});
