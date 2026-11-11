import { reportLaunchEvents } from '@/drop-forge/drop-forge.notifier';
import {
  DropForgeRepository,
  addLaunchEvent
} from '@/drop-forge/drop-forge.repository';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';
import { DROP_FORGE_ALERT_MENTION } from '@/constants/mentions';
import { signForgeReport } from '@/drop-forge/drop-forge.report-signing';
jest.mock('@/drops/create-or-update-drop.use-case', () => ({
  createOrUpdateDrop: { execute: jest.fn() }
}));
jest.mock('@/drops/drops.db', () => ({
  dropsDb: { updateHideLinkPreview: jest.fn().mockResolvedValue(undefined) }
}));
jest.mock('@/drop-forge/drop-forge.report-signing', () => ({
  signForgeReport: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('@/drop-forge/drop-forge.reporting-access', () => ({
  validateForgeReporting: jest.fn().mockResolvedValue('bot')
}));
jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: jest.fn().mockResolvedValue(undefined)
}));
const repository = new DropForgeRepository();
let records: LaunchRecord[];
function record(id: string): LaunchRecord {
  const result: LaunchRecord = {
    id,
    revision: 1,
    state: 'RUNNING',
    error: null,
    data: testLaunchData(),
    updated_at: 0
  };
  addLaunchEvent(result, id + ' first');
  addLaunchEvent(result, id + ' second');
  return result;
}
beforeEach(() => {
  jest.clearAllMocks();
  records = [record('launch')];
  jest
    .spyOn(repository, 'find')
    .mockImplementation(
      async (id) => records.find((row) => row.id === id) ?? null
    );
  jest.spyOn(repository, 'reporting').mockImplementation(async () => records);
  jest.spyOn(repository, 'change').mockImplementation(async (id, work) => {
    const original = records.find((row) => row.id === id)!;
    const working = structuredClone(original);
    const result = await work(working, {});
    Object.assign(original, working);
    return result;
  });
});
afterEach(() => jest.restoreAllMocks());
it('posts new preview output only in the operations wave and tags only failures', async () => {
  const previous = process.env.DEPLOYER_ANNOUNCEMENTS_WAVE_IDS;
  process.env.DEPLOYER_ANNOUNCEMENTS_WAVE_IDS = 'unrelated-announcement-wave';
  records[0].data.events = [];
  addLaunchEvent(
    records[0],
    '🔔 **Public mint closed**\n\nResearch: 18 editions'
  );
  records[0].data.events[0].formatted = true;
  addLaunchEvent(records[0], 'Supply mismatch', true);
  jest.mocked(createOrUpdateDrop.execute).mockResolvedValue({
    drop_id: 'posted',
    dm_unread_recipient_ids: [],
    pending_push_notification_ids: []
  });
  try {
    await reportLaunchEvents(testConfig, repository, 'launch');
    const messages = jest
      .mocked(createOrUpdateDrop.execute)
      .mock.calls.map(([request]) => request);
    expect(messages.map((message) => message.wave_id)).toEqual([
      testConfig.waveId,
      testConfig.waveId
    ]);
    expect(messages[0].parts[0].content).toBe(
      '🔔 **Public mint closed**\n\nResearch: 18 editions'
    );
    expect(messages[1].parts[0].content).toContain(DROP_FORGE_ALERT_MENTION);
    expect(signForgeReport).toHaveBeenCalledWith(
      'posted',
      testConfig.botId,
      expect.objectContaining({
        wave_id: testConfig.waveId,
        parts: [{ content: messages[1].parts[0].content, media: [] }],
        hide_link_preview: true
      }),
      expect.any(Object)
    );
  } finally {
    if (previous === undefined)
      delete process.env.DEPLOYER_ANNOUNCEMENTS_WAVE_IDS;
    else process.env.DEPLOYER_ANNOUNCEMENTS_WAVE_IDS = previous;
  }
});
it('leaves a report pending when signing fails and acknowledges its retry once', async () => {
  records[0].data.events = [];
  addLaunchEvent(records[0], 'Launch completed');
  jest.mocked(createOrUpdateDrop.execute).mockResolvedValue({
    drop_id: 'signed-report',
    dm_unread_recipient_ids: [],
    pending_push_notification_ids: [1]
  });
  jest
    .mocked(signForgeReport)
    .mockRejectedValueOnce(new Error('KMS unavailable'));

  expect(await reportLaunchEvents(testConfig, repository, 'launch')).toBe(
    false
  );
  expect(records[0].data.events[0].drop_id).toBeFalsy();
  expect(sendIdentityPushNotifications).not.toHaveBeenCalled();
  expect(await reportLaunchEvents(testConfig, repository, 'launch')).toBe(true);
  expect(records[0].data.events[0].drop_id).toBe('signed-report');
  expect(sendIdentityPushNotifications).toHaveBeenCalledTimes(1);
});
it('posts events in order and commits their acknowledgements before pushing notifications', async () => {
  type Report = Awaited<ReturnType<typeof createOrUpdateDrop.execute>>;
  let release!: (report: Report) => void;
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  jest
    .mocked(createOrUpdateDrop.execute)
    .mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    })
    .mockResolvedValueOnce({
      drop_id: 'second',
      dm_unread_recipient_ids: [],
      pending_push_notification_ids: [2]
    });
  const reporting = reportLaunchEvents(testConfig, repository, 'launch');
  await firstEntered;
  expect(createOrUpdateDrop.execute).toHaveBeenCalledTimes(1);
  expect(sendIdentityPushNotifications).not.toHaveBeenCalled();
  release({
    drop_id: 'first',
    dm_unread_recipient_ids: [],
    pending_push_notification_ids: [1]
  });
  expect(await reporting).toBe(true);
  expect(records[0].data.events.map((event) => event.drop_id)).toEqual([
    'first',
    'second'
  ]);
  expect(sendIdentityPushNotifications).toHaveBeenCalledWith([1, 2]);
});
it('leaves a failed batch unacknowledged and still processes later launches', async () => {
  records.push(record('other'));
  jest
    .mocked(createOrUpdateDrop.execute)
    .mockResolvedValueOnce({
      drop_id: 'rolled-back',
      dm_unread_recipient_ids: [],
      pending_push_notification_ids: []
    })
    .mockRejectedValueOnce(new Error('wave unavailable'))
    .mockResolvedValue({
      drop_id: 'durable',
      dm_unread_recipient_ids: [],
      pending_push_notification_ids: []
    });
  expect(await reportLaunchEvents(testConfig, repository)).toBe(false);
  expect(records[0].data.events.every((event) => !event.drop_id)).toBe(true);
  expect(
    records[1].data.events.every((event) => event.drop_id === 'durable')
  ).toBe(true);
  expect(createOrUpdateDrop.execute).toHaveBeenCalledTimes(4);
  expect(sendIdentityPushNotifications).toHaveBeenCalledTimes(1);
});
