import { runLaunchDelivery } from './index';
import { dropForgeRepository } from '@/drop-forge/drop-forge.repository';
import { DropForgeWorker } from '@/drop-forge/drop-forge.worker';
import * as dispatch from '@/drop-forge/drop-forge.dispatch';
import * as config from '@/drop-forge/drop-forge.config';
import { reportLaunchEvents } from '@/drop-forge/drop-forge.notifier';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
import { LaunchRecord } from '@/drop-forge/drop-forge.types';

jest.mock('@/drop-forge/drop-forge.settings', () => ({
  ...jest.requireActual('@/drop-forge/drop-forge.settings'),
  readForgeSettings: jest.fn(async () => ({
    revision: 1,
    automation_enabled: true,
    pay_artist_enabled: true
  }))
}));
jest.mock('@/secrets', () => ({ doInDbContext: jest.fn() }));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (handler: unknown) => handler
}));
jest.mock('@/drop-forge/drop-forge.chain', () => ({
  EthereumLaunchChain: jest.fn()
}));
jest.mock('@/drop-forge/kms-signer', () => ({
  KmsTransactionSigner: jest.fn()
}));
jest.mock('@/drop-forge/drop-forge.preview', () => ({
  recordPostMintPreview: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('@/drop-forge/drop-forge.notifier', () => ({
  reportLaunchEvents: jest.fn().mockResolvedValue(true)
}));
jest.mock('@/drop-forge/drop-forge.dispatch', () => ({
  scheduleLaunchGroups: jest.fn().mockResolvedValue(undefined),
  launchWatchdog: jest.fn().mockResolvedValue('watchdog'),
  removeLaunchWatchdog: jest.fn().mockResolvedValue(undefined),
  continueLaunch: jest.fn().mockResolvedValue(undefined)
}));
let current: LaunchRecord;
let tick: jest.SpyInstance;
beforeEach(() => {
  current = {
    id: 'target-launch',
    revision: 5,
    state: 'RUNNING',
    error: null,
    updated_at: 0,
    data: testLaunchData()
  };
  jest.spyOn(config, 'getDropForgeConfig').mockReturnValue(testConfig);
  jest.spyOn(config, 'automationEnabled').mockReturnValue(true);
  jest
    .spyOn(dropForgeRepository, 'find')
    .mockImplementation(async () => current);
  tick = jest.spyOn(DropForgeWorker.prototype, 'tick').mockResolvedValue();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
it('rejects early delivery before its committed revision without creating schedules or touching the signer', async () => {
  await expect(
    runLaunchDelivery({ id: current.id, revision: 6 })
  ).rejects.toThrow('not committed');
  expect(dispatch.scheduleLaunchGroups).not.toHaveBeenCalled();
  expect(tick).not.toHaveBeenCalled();
});
it('installs independent groups and a crash watchdog before targeted transaction processing', async () => {
  await runLaunchDelivery({ id: current.id, revision: 5 });
  expect(dispatch.scheduleLaunchGroups).toHaveBeenCalledWith(
    current,
    expect.any(Number)
  );
  expect(tick).toHaveBeenCalledWith(current.id);
  expect(
    jest.mocked(dispatch.scheduleLaunchGroups).mock.invocationCallOrder[0]
  ).toBeLessThan(tick.mock.invocationCallOrder[0]);
  expect(
    jest.mocked(dispatch.launchWatchdog).mock.invocationCallOrder[0]
  ).toBeLessThan(tick.mock.invocationCallOrder[0]);
  expect(dispatch.continueLaunch).toHaveBeenCalledWith(
    current,
    expect.any(Number),
    true,
    expect.objectContaining({ automation_enabled: true })
  );
  expect(dispatch.removeLaunchWatchdog).toHaveBeenCalledWith(
    current.id,
    'watchdog'
  );
});
it('keeps the watchdog armed while work is in flight, including if the process is killed', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  tick.mockImplementationOnce(() => {
    entered();
    return held;
  });
  const processing = runLaunchDelivery({ id: current.id, revision: 5 });
  await started;
  expect(dispatch.launchWatchdog).toHaveBeenCalled();
  expect(dispatch.removeLaunchWatchdog).not.toHaveBeenCalled();
  release();
  await processing;
});
it('retains the original queue delivery on failure without spawning a continuation retry tree', async () => {
  tick.mockRejectedValueOnce(new Error('RPC unavailable'));
  await expect(
    runLaunchDelivery({ id: current.id, revision: 5 })
  ).rejects.toThrow('RPC unavailable');
  expect(dispatch.scheduleLaunchGroups).toHaveBeenCalled();
  expect(dispatch.continueLaunch).not.toHaveBeenCalled();
  expect(dispatch.removeLaunchWatchdog).toHaveBeenCalled();
});
it('does not acknowledge a reporting failure or silently discard disabled queued work', async () => {
  jest.mocked(reportLaunchEvents).mockResolvedValueOnce(false);
  await expect(
    runLaunchDelivery({ id: current.id, revision: 5 })
  ).rejects.toThrow('wave delivery');
  expect(dispatch.continueLaunch).not.toHaveBeenCalled();
  jest.mocked(config.automationEnabled).mockReturnValue(false);
  await runLaunchDelivery({ id: current.id, revision: 5 });
  expect(dispatch.continueLaunch).toHaveBeenLastCalledWith(
    current,
    expect.any(Number),
    false,
    expect.any(Object)
  );
});
