import * as emma from '@/api/subscriptions/api.subscriptions.allowlist';
import { randomUUID } from 'node:crypto';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import { createProcess, processStep } from '@/drop-forge/drop-forge.workflow';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import * as preparation from '@/drop-forge/drop-forge.preparation';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import { resetDistributionPreparation } from '@/drop-forge/drop-forge.preparation.repository';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
beforeEach(async () => {
  await clearDropForgeTestTables();
  jest
    .spyOn(emma, 'validateDistribution')
    .mockResolvedValue({ valid: true, statusText: 'OK', allowlist_id: 'plan' });
  jest
    .spyOn(emma, 'fetchPhaseName')
    .mockImplementation(
      async (_auth, _plan, id) => `Phase ${['zero', 'one', 'two'].indexOf(id)}`
    );
  jest.spyOn(emma, 'fetchPhaseResults').mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());
const job = () =>
  Object.assign(new DropForgeJobEntity(), {
    id: randomUUID(),
    contract: testConfig.creator,
    claim_id: 1,
    kind: 'PROCESS_ALL',
    plan_id: 'plan',
    phase_id: null,
    phase_ids: ['zero', 'one', 'two'],
    step: 0,
    updated_at: Date.now()
  });
it('deduplicates Process clicks and discovers the same workflow after refresh', async () => {
  const first = await createProcess(job(), {});
  const second = await createProcess(job(), {});
  expect(second.id).toBe(first.id);
  expect(
    (await dropForgeJobsRepository.latest(testConfig.creator, 1, 'plan', {}))
      ?.id
  ).toBe(first.id);
  await expect(
    createProcess({ ...job(), phase_ids: ['a', 'b', 'c'] }, {})
  ).rejects.toThrow('different processing');
});
it('checkpoints each phase and completes only after public processing and finalization', async () => {
  const first = await createProcess(job(), {});
  const prepare = jest
    .spyOn(preparation, 'prepareDistributionPhase')
    .mockImplementation(async (_contract, _claim, _plan, id) => ({
      phase:
        id === 'public'
          ? 'Public'
          : `Phase ${['zero', 'one', 'two'].indexOf(id)}`,
      airdrops: [],
      airdrops_unconsolidated: [],
      allowlists: []
    }));
  const finalize = jest
    .spyOn(preparation, 'finalizeDistribution')
    .mockResolvedValue();
  for (let step = 0; step < 5; step++) {
    await dropForgeJobsRepository.processOne(
      (next, ctx) => processStep(next, 'auth', ctx),
      {}
    );
    const current = await dropForgeJobsRepository.find(first.id, {});
    expect(current.status).toBe(step === 4 ? 'COMPLETED' : 'PENDING');
    expect(current.step).toBe(Math.min(step + 1, 4));
  }
  expect(prepare.mock.calls.map((call) => call[3])).toEqual([
    'zero',
    'one',
    'two',
    'public'
  ]);
  expect(finalize).toHaveBeenCalledTimes(1);
});
it('rejects resetting inputs while processing and exposes a failed outcome without completing', async () => {
  const first = await createProcess(job(), {});
  await expect(
    resetDistributionPreparation(testConfig.creator, 1, async () => {}, {})
  ).rejects.toThrow('in progress');
  jest
    .spyOn(preparation, 'prepareDistributionPhase')
    .mockRejectedValue(new Error('EMMA unavailable'));
  await dropForgeJobsRepository.processOne(
    (next, ctx) => processStep(next, 'auth', ctx),
    {}
  );
  expect((await dropForgeJobsRepository.find(first.id, {})).status).toBe(
    'FAILED'
  );
});
