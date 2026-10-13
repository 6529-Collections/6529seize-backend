import { runPreparationTick } from './index';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import * as workflow from '@/drop-forge/drop-forge.workflow';
import * as preparation from '@/drop-forge/drop-forge.preparation';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import {
  encryptPreparationAuth,
  PreparationAuthRequired
} from '@/drop-forge/drop-forge.preparation-auth';
import { CustomApiCompliantException } from '@/exceptions';

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
const oldFlag = process.env.DROP_FORGE_PREPARATION_ENABLED;
const oldSecret = process.env.JWT_SECRET;
beforeEach(() => {
  process.env.DROP_FORGE_PREPARATION_ENABLED = 'true';
  process.env.JWT_SECRET = 'worker-preparation-test-secret';
  current = Object.assign(new DropForgeJobEntity(), {
    id: 'job',
    contract: 'creator',
    claim_id: 1,
    kind: 'PROCESS_ALL',
    plan_id: 'plan',
    phase_id: null,
    phase_ids: ['a', 'b', 'c'],
    step: 0,
    result: null
  });
  current.encrypted_auth = encryptPreparationAuth(
    current,
    'Bearer clicking-operator'
  );
  jest
    .spyOn(dropForgeJobsRepository, 'processOne')
    .mockImplementation(async (operation) => {
      await operation(current, {});
    });
  jest.spyOn(workflow, 'processStep').mockResolvedValue({
    continue: true,
    inputs: { saved: { name: 'Phase 0', rows: [] } },
    lists: {}
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (oldFlag === undefined) delete process.env.DROP_FORGE_PREPARATION_ENABLED;
  else process.env.DROP_FORGE_PREPARATION_ENABLED = oldFlag;
  if (oldSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = oldSecret;
});
it('uses the clicking operator credential for the background input capture', async () => {
  await runPreparationTick();
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
  await runPreparationTick();
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
  await expect(runPreparationTick()).rejects.toThrow(PreparationAuthRequired);
  current.encrypted_auth = null;
  await expect(runPreparationTick()).rejects.toThrow(PreparationAuthRequired);
});
it('does not require EMMA authentication for finalization or public subscription processing', async () => {
  const finalize = jest
    .spyOn(preparation, 'finalizeDistribution')
    .mockResolvedValue();
  current.kind = 'FINALIZE';
  current.encrypted_auth = null;
  await runPreparationTick();
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
  await runPreparationTick();
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
  process.env.DROP_FORGE_PREPARATION_ENABLED = 'false';
  await runPreparationTick();
  expect(dropForgeJobsRepository.processOne).not.toHaveBeenCalled();
});
