import { randomUUID } from 'crypto';
import { DROP_FORGE_PREPARATIONS_TABLE } from '@/constants';
import {
  dropForgePreparationRepository,
  resetDistributionPreparation
} from '@/drop-forge/drop-forge.preparation.repository';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import { sqlExecutor } from '@/sql-executor';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
import {
  DropForgeRepository,
  launchId
} from '@/drop-forge/drop-forge.repository';

const result = {
  phase: 'Phase 0',
  airdrops: [{ wallet: 'wallet', amount: 1 }],
  airdrops_unconsolidated: [],
  allowlists: []
};
describe('Drop Forge preparation durability', () => {
  beforeEach(clearDropForgeTestTables);
  const contract = testConfig.creator.toLowerCase();
  const prepared = async () => {
    const row = await sqlExecutor.oneOrNull<{ results: string }>(
      `SELECT results FROM ${DROP_FORGE_PREPARATIONS_TABLE} WHERE id = :id`,
      { id: `${contract}:1` }
    );
    return row ? JSON.parse(row.results) : null;
  };
  it('serializes concurrent phase retries and returns the committed result', async () => {
    let writes = 0;
    const process = () =>
      dropForgePreparationRepository.run(
        contract,
        1,
        async (cache) => {
          if (cache.phase) return cache.phase;
          writes++;
          cache.phase = result;
          return result;
        },
        {}
      );
    const outputs = await Promise.all([process(), process()]);
    expect(outputs).toEqual([result, result]);
    expect(writes).toBe(1);
    expect(await prepared()).toEqual({ phase: result });
  });
  it('rolls back a job’s partial writes while recording a durable failure', async () => {
    const id = randomUUID();
    const job = Object.assign(new DropForgeJobEntity(), {
      id,
      contract,
      claim_id: 1,
      kind: 'PHASE',
      plan_id: 'plan',
      phase_id: 'phase',
      updated_at: Date.now()
    });
    await dropForgeJobsRepository.create(job, {});
    await dropForgeJobsRepository.processOne(async (_, ctx) => {
      await dropForgePreparationRepository.run(
        contract,
        1,
        async (cache) => {
          cache.phase = result;
          return result;
        },
        ctx
      );
      throw new Error('failure after writes');
    }, {});
    const stored = await dropForgeJobsRepository.find(id, {});
    expect(stored.status).toBe('FAILED');
    expect(stored.result).toBeNull();
    expect(await prepared()).toBeNull();
    // Retrying the same request ID does not enqueue a second mutation.
    expect((await dropForgeJobsRepository.create(job, {})).status).toBe(
      'FAILED'
    );
  });
  it('acknowledges a preparation report atomically, so retries do not repost it', async () => {
    const id = randomUUID();
    await dropForgeJobsRepository.create(
      Object.assign(new DropForgeJobEntity(), {
        id,
        contract,
        claim_id: 1,
        kind: 'FINALIZE',
        plan_id: null,
        phase_id: null,
        updated_at: Date.now()
      }),
      {}
    );
    await dropForgeJobsRepository.processOne(
      async () => ({ normalized: true }),
      {}
    );
    const report = jest.fn().mockResolvedValue({
      drop_id: 'durable-drop',
      pending_push_notification_ids: [1]
    });
    expect(await dropForgeJobsRepository.reportOne(report, {})).toEqual([1]);
    expect(await dropForgeJobsRepository.reportOne(report, {})).toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
  });
  it('clears retry results with an explicit reset and refuses reset after arming', async () => {
    await dropForgePreparationRepository.run(
      contract,
      1,
      async (cache) => {
        cache.phase = result;
      },
      {}
    );
    await resetDistributionPreparation(contract, 1, async () => {});
    expect(await prepared()).toEqual({});
    const launches = new DropForgeRepository();
    const id = launchId(testConfig.chainId, contract, 1);
    await launches.putDraft(id, 0, testLaunchData(), {});
    await launches.change(
      id,
      async (record) => {
        record.state = 'ARMED';
      },
      {}
    );
    await expect(
      resetDistributionPreparation(contract, 1, async () => {})
    ).rejects.toThrow('frozen');
  });
});
