import * as policy from '@/drop-forge/drop-forge.policy';
import { randomUUID } from 'crypto';
import { DISTRIBUTION_TABLE, DROP_FORGE_PREPARATIONS_TABLE } from '@/constants';
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
  it('keeps a preparation mode across competing requests until reset', async () => {
    const start = (mode: 'MANUAL' | 'BACKGROUND', operation = async () => {}) =>
      dropForgePreparationRepository.run(
        contract,
        1,
        operation,
        {},
        false,
        false,
        mode
      );
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manual = start('MANUAL', async () => {
      entered();
      await locked;
    });
    await Promise.race([waiting, manual]);
    const refused = expect(start('BACKGROUND')).rejects.toThrow(
      'using manual preparation'
    );
    release();
    await manual;
    await refused;
    await expect(
      dropForgePreparationRepository.readMode(contract, 1)
    ).resolves.toBe('MANUAL');
    await resetDistributionPreparation(contract, 1, async () => {});
    await expect(
      dropForgePreparationRepository.readMode(contract, 1)
    ).resolves.toBe('UNSTARTED');
    await start('BACKGROUND');
    await expect(start('MANUAL')).rejects.toThrow(
      'using background preparation'
    );
  });

  it('recognizes legacy phase writes and treats an artist upload as unstarted', async () => {
    const insert = (phase: string) =>
      sqlExecutor.execute(
        `INSERT INTO ${DISTRIBUTION_TABLE}
        (contract, card_id, phase, wallet, wallet_tdh, wallet_balance, wallet_unique_balance, count, count_airdrop, count_allowlist)
        VALUES (:contract, 1, :phase, :wallet, 0, 0, 0, 1, 1, 0)`,
        { contract, phase, wallet: testConfig.signer }
      );
    try {
      await insert('Airdrop - Artist');
      await expect(
        dropForgePreparationRepository.readMode(contract, 1)
      ).resolves.toBe('UNSTARTED');
      await insert('Phase 0');
      await expect(
        dropForgePreparationRepository.readMode(contract, 1)
      ).resolves.toBe('MANUAL');
    } finally {
      await sqlExecutor.execute(
        `DELETE FROM ${DISTRIBUTION_TABLE} WHERE contract = :contract AND card_id = 1 AND wallet = :wallet`,
        { contract, wallet: testConfig.signer }
      );
    }
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

it('lets an operator explicitly reset a paused preparation while the setting is off', async () => {
  await clearDropForgeTestTables();
  jest
    .spyOn(policy, 'findDropForgePolicy')
    .mockReturnValue(
      testConfig as ReturnType<typeof policy.findDropForgePolicy>
    );
  const job = await dropForgeJobsRepository.create(
    Object.assign(new DropForgeJobEntity(), {
      id: randomUUID(),
      contract: testConfig.creator.toLowerCase(),
      claim_id: 1,
      kind: 'PROCESS_ALL',
      plan_id: 'plan',
      phase_id: null,
      phase_ids: ['phase0', 'phase1', 'phase2'],
      step: 0,
      updated_at: Date.now()
    }),
    {}
  );
  await expect(
    dropForgePreparationRepository.readMode(job.contract, job.claim_id)
  ).resolves.toBe('BACKGROUND');
  const reset = jest.fn().mockResolvedValue(undefined);
  await resetDistributionPreparation(job.contract, job.claim_id, reset);
  expect(reset).toHaveBeenCalledTimes(1);
  await expect(
    dropForgePreparationRepository.readMode(job.contract, job.claim_id)
  ).resolves.toBe('UNSTARTED');
  await expect(
    dropForgeJobsRepository.latest(job.contract, job.claim_id, 'plan', {})
  ).resolves.toBeNull();
  await expect(dropForgeJobsRepository.find(job.id, {})).resolves.toMatchObject(
    {
      status: 'FAILED',
      encrypted_auth: null,
      error: 'Distribution reset; process again'
    }
  );
});
