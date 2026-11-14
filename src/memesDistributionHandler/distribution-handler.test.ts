import { runPreparationJob } from './index';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import { getDropForgePolicy } from '@/drop-forge/drop-forge.policy';
import { readForgeSettings } from '@/drop-forge/drop-forge.settings';
import { MEMES_CONTRACT } from '@/constants';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
import * as workflow from '@/drop-forge/drop-forge.workflow';
import * as preparation from '@/drop-forge/drop-forge.preparation';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import {
  encryptPreparationAuth,
  PreparationAuthRequired
} from '@/drop-forge/drop-forge.preparation-auth';
import { CustomApiCompliantException } from '@/exceptions';
import { wakeDropForge } from '@/drop-forge/drop-forge.wake';

jest.mock('@/drop-forge/drop-forge.dispatch', () => ({
  launchWatchdog: jest.fn().mockResolvedValue('watchdog'),
  removeLaunchWatchdog: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('@/secrets', () => ({ doInDbContext: jest.fn() }));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (handler: unknown) => handler
}));
jest.mock('@/drop-forge/drop-forge.config', () => ({
  getDropForgeReportingConfig: () => ({})
}));
jest.mock('@/drop-forge/drop-forge.notifier', () => ({
  reportPreparationJob: jest.fn().mockResolvedValue(true)
}));
jest.mock('@/drop-forge/drop-forge.wake', () => ({
  wakeDropForge: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('@/redis', () => ({ evictRedisCacheForPathWithTimeout: jest.fn() }));

let current: DropForgeJobEntity;
jest.mock('@/drop-forge/drop-forge.policy');
jest.mock('@/drop-forge/drop-forge.settings');
const settings = {
  id: 'settings',
  revision: 1,
  automation_enabled: false,
  preparation_enabled: true,
  pay_artist_enabled: false,
  max_artist_payment_wei: null,
  updated_by: null,
  updated_at: 0
};
const oldSecret = process.env.JWT_SECRET;
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(getDropForgePolicy)
    .mockReturnValue({ ...testConfig, chainId: 1, creator: MEMES_CONTRACT });
  jest.mocked(readForgeSettings).mockResolvedValue(settings);
  process.env.JWT_SECRET = 'worker-preparation-test-secret';
  current = Object.assign(new DropForgeJobEntity(), {
    id: 'job',
    dispatch_revision: 1,
    status: 'PENDING',
    contract: 'creator',
    claim_id: 1,
    kind: 'PROCESS_ALL',
    plan_id: 'plan',
    phase_id: null,
    phase_ids: ['a', 'b', 'c'],
    step: 0,
    result: null
  });
  jest
    .spyOn(dropForgeJobsRepository, 'find')
    .mockImplementation(async () => current);
  current.encrypted_auth = encryptPreparationAuth(
    current,
    'Bearer clicking-operator'
  );
  jest
    .spyOn(dropForgeJobsRepository, 'processOne')
    .mockImplementation(async (operation, _ctx, _id, shouldProcess) => {
      if (shouldProcess && !(await shouldProcess({}))) return false;
      const result = (await operation(current, {})) as { continue?: boolean };
      current.result = result;
      current.status = result.continue ? 'PENDING' : 'COMPLETED';
      return true;
    });
  jest.spyOn(workflow, 'processStep').mockResolvedValue({
    continue: true,
    inputs: { saved: { name: 'Phase 0', rows: [] } },
    lists: {}
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (oldSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = oldSecret;
});
it('uses the clicking operator credential for the background input capture', async () => {
  await runPreparationJob({ id: current.id, revision: 1 });
  expect(workflow.processStep).toHaveBeenCalledWith(
    current,
    'Bearer clicking-operator',
    expect.anything()
  );
});
it('continues from captured inputs without retaining or requiring an operator credential', async () => {
  current.encrypted_auth = null;
  current.step = 1;
  current.result = { inputs: { frozen: true }, lists: {}, continue: true };
  await runPreparationJob({ id: current.id, revision: 1 });
  expect(workflow.processStep).toHaveBeenCalledWith(
    current,
    '',
    expect.anything()
  );
});
it('classifies expired EMMA access as resumable and missing legacy credentials the same way', async () => {
  jest
    .mocked(workflow.processStep)
    .mockRejectedValue(
      new CustomApiCompliantException(401, 'upstream token expired')
    );
  await expect(
    runPreparationJob({ id: current.id, revision: 1 })
  ).rejects.toThrow(PreparationAuthRequired);
  current.encrypted_auth = null;
  await expect(
    runPreparationJob({ id: current.id, revision: 1 })
  ).rejects.toThrow(PreparationAuthRequired);
});
it('does not require EMMA authentication for finalization or public subscription processing', async () => {
  const finalize = jest
    .spyOn(preparation, 'finalizeDistribution')
    .mockResolvedValue();
  current.kind = 'FINALIZE';
  current.encrypted_auth = null;
  await runPreparationJob({ id: current.id, revision: 1 });
  expect(finalize).toHaveBeenCalledTimes(1);
  current.kind = 'PHASE';
  current.phase_id = 'public';
  const prepare = jest
    .spyOn(preparation, 'prepareDistributionPhase')
    .mockResolvedValue({
      phase: 'Public',
      airdrops: [],
      airdrops_unconsolidated: [],
      allowlists: []
    });
  await runPreparationJob({ id: current.id, revision: 1 });
  expect(prepare).toHaveBeenCalledWith(
    'creator',
    1,
    'plan',
    'public',
    '',
    expect.anything()
  );
});
it('does no processing while the preparation switch is disabled', async () => {
  jest.mocked(readForgeSettings).mockResolvedValue({
    ...settings,
    preparation_enabled: false
  });
  await expect(
    runPreparationJob({ id: current.id, revision: 1 })
  ).resolves.toBeUndefined();
  expect(dropForgeJobsRepository.processOne).not.toHaveBeenCalled();
});
it('finishes the current step and stops publishing continuations after preparation is turned Off', async () => {
  jest
    .mocked(readForgeSettings)
    .mockResolvedValueOnce(settings)
    .mockResolvedValueOnce(settings)
    .mockResolvedValue({ ...settings, preparation_enabled: false });
  await runPreparationJob({ id: current.id, revision: 1 });
  expect(workflow.processStep).toHaveBeenCalledTimes(1);
  expect(current.status).toBe('PENDING');
  expect(wakeDropForge).not.toHaveBeenCalled();
});
it('retries a resume delivery that arrived before the enabling settings committed', async () => {
  await expect(
    runPreparationJob({ id: current.id, revision: 1, preparation_revision: 2 })
  ).rejects.toThrow('settings have not committed');
  expect(dropForgeJobsRepository.processOne).not.toHaveBeenCalled();
});
it('ignores a stale checkpoint watchdog and rejects delivery before the dispatch commit', async () => {
  current.step = 2;
  await runPreparationJob({ id: current.id, revision: 1, step: 1 });
  expect(dropForgeJobsRepository.processOne).not.toHaveBeenCalled();
  await expect(
    runPreparationJob({ id: current.id, revision: 2 })
  ).rejects.toThrow('not committed');
});
it('continues from a watchdog delivery without retaining its stale checkpoint filter', async () => {
  current.step = 1;
  current.result = { inputs: { frozen: true }, lists: {}, continue: true };
  await runPreparationJob({ id: current.id, revision: 1, step: 1 });
  expect(wakeDropForge).toHaveBeenLastCalledWith(
    { id: current.id, revision: 1 },
    true,
    1
  );
});
it('backs off a concurrent delivery when another invocation owns the job checkpoint', async () => {
  jest.mocked(dropForgeJobsRepository.processOne).mockResolvedValueOnce(false);
  await runPreparationJob({ id: current.id, revision: 1 });
  expect(wakeDropForge).toHaveBeenLastCalledWith(
    { id: current.id, revision: 1 },
    true,
    60
  );
});
