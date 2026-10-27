import * as emma from '@/api/subscriptions/api.subscriptions.allowlist';
import { randomUUID } from 'node:crypto';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import { createProcess, processStep } from '@/drop-forge/drop-forge.workflow';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import * as preparation from '@/drop-forge/drop-forge.preparation';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import { resetDistributionPreparation } from '@/drop-forge/drop-forge.preparation.repository';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
import { sqlExecutor } from '@/sql-executor';
import {
  decryptPreparationAuth,
  PreparationAuthRequired
} from '@/drop-forge/drop-forge.preparation-auth';
beforeEach(async () => {
  process.env.JWT_SECRET = 'preparation-auth-test-secret';
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
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.JWT_SECRET;
});
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
  const first = await createProcess(job(), {}, 'Bearer operator-token');
  const second = await createProcess(job(), {}, 'Bearer operator-token');
  expect(second.id).toBe(first.id);
  expect(
    (await dropForgeJobsRepository.latest(testConfig.creator, 1, 'plan', {}))
      ?.id
  ).toBe(first.id);
  await expect(
    createProcess(
      { ...job(), phase_ids: ['a', 'b', 'c'] },
      {},
      'Bearer operator-token'
    )
  ).rejects.toThrow('different processing');
});
it('checkpoints each phase and completes only after public processing and finalization', async () => {
  const first = await createProcess(job(), {}, 'Bearer operator-token');
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
    expect(current.encrypted_auth).toBeNull();
  }
  expect(prepare.mock.calls.map((call) => call[3])).toEqual([
    'zero',
    'one',
    'two',
    'public'
  ]);
  expect(finalize).toHaveBeenCalledTimes(1);
});
it('retains the credential if a crash rolls back the input checkpoint, then clears it with the successful commit', async () => {
  const first = await createProcess(job(), {}, 'Bearer operator-token');
  const execute = sqlExecutor.execute.bind(sqlExecutor);
  const failure = jest
    .spyOn(sqlExecutor, 'execute')
    .mockImplementation(async (sql, params, options) => {
      if (sql.includes('SET step = :step'))
        throw new Error('checkpoint persistence failed');
      return execute(sql, params, options);
    });
  await expect(
    dropForgeJobsRepository.processOne(
      async () => ({ continue: true, inputs: { frozen: true }, lists: {} }),
      {}
    )
  ).rejects.toThrow('checkpoint persistence failed');
  failure.mockRestore();
  const rolledBack = await dropForgeJobsRepository.find(first.id, {});
  expect(rolledBack.step).toBe(0);
  expect(rolledBack.result).toBeNull();
  expect(decryptPreparationAuth(rolledBack)).toBe('Bearer operator-token');
  await dropForgeJobsRepository.processOne(
    async () => ({ continue: true, inputs: { frozen: true }, lists: {} }),
    {}
  );
  expect(
    (await dropForgeJobsRepository.find(first.id, {})).encrypted_auth
  ).toBeNull();
});
it('pauses for expired operator access and resumes the same job without replaying checkpoints', async () => {
  const first = await createProcess(job(), {}, 'Bearer old-token');
  expect(decryptPreparationAuth(first)).toBe('Bearer old-token');
  await dropForgeJobsRepository.processOne(async () => {
    throw new PreparationAuthRequired();
  }, {});
  const waiting = await dropForgeJobsRepository.find(first.id, {});
  expect(waiting.status).toBe('AWAITING_AUTH');
  expect(waiting.encrypted_auth).toBeNull();
  expect(waiting.step).toBe(0);
  await expect(
    resetDistributionPreparation(testConfig.creator, 1, async () => {}, {})
  ).rejects.toThrow('in progress');
  const resumed = await createProcess(job(), {}, 'Bearer fresh-token');
  expect(resumed.id).toBe(first.id);
  expect(resumed.status).toBe('PENDING');
  expect(decryptPreparationAuth(resumed)).toBe('Bearer fresh-token');
  await dropForgeJobsRepository.processOne(
    async () => ({
      continue: true,
      inputs: { frozen: true },
      lists: { phase: {} }
    }),
    {}
  );
  const captured = await dropForgeJobsRepository.find(first.id, {});
  expect(captured.encrypted_auth).toBeNull();
  expect(captured.step).toBe(1);
  const checkpoint = captured.result;
  await dropForgeJobsRepository.processOne(async () => {
    throw new PreparationAuthRequired();
  }, {});
  const paused = await dropForgeJobsRepository.find(first.id, {});
  expect(paused.step).toBe(1);
  expect(paused.result).toEqual(checkpoint);
  await createProcess(job(), {}, 'Bearer renewed-token');
  expect((await dropForgeJobsRepository.find(first.id, {})).result).toEqual(
    checkpoint
  );
});
it('rejects resetting inputs while processing and exposes a failed outcome without completing', async () => {
  const first = await createProcess(job(), {}, 'Bearer operator-token');
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
  expect(
    (await dropForgeJobsRepository.find(first.id, {})).encrypted_auth
  ).toBeNull();
});
