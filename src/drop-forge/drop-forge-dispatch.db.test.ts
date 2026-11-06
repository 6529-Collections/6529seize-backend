import { randomUUID } from 'node:crypto';
import { clearDropForgeTestTables } from '@/drop-forge/drop-forge.db-test-fixtures';
import { DropForgeRepository } from '@/drop-forge/drop-forge.repository';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import {
  testConfig,
  testLaunchData
} from '@/drop-forge/drop-forge.test-fixtures';
import { DropForgeJobEntity } from '@/entities/IDropForgeLaunch';
import * as wake from '@/drop-forge/drop-forge.wake';
import { sqlExecutor } from '@/sql-executor';
import { resetDistributionPreparation } from '@/drop-forge/drop-forge.preparation.repository';

const repository = new DropForgeRepository();
beforeEach(clearDropForgeTestTables);
afterEach(() => jest.restoreAllMocks());
const job = () =>
  Object.assign(new DropForgeJobEntity(), {
    id: randomUUID(),
    contract: testConfig.creator.toLowerCase(),
    claim_id: 1,
    kind: 'FINALIZE',
    plan_id: null,
    phase_id: null,
    phase_ids: null,
    updated_at: Date.now()
  });
it('rolls back launch activation when durable publication fails', async () => {
  const launch = await repository.putDraft('launch', 0, testLaunchData(), {});
  jest
    .mocked(wake.wakeDropForge)
    .mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(
    repository.change(
      launch.id,
      (record) => {
        record.state = 'ARMED';
      },
      {},
      true
    )
  ).rejects.toThrow('queue unavailable');
  expect((await repository.find(launch.id, {}))!.state).toBe('DRAFT');
  expect((await repository.find(launch.id, {}))!.revision).toBe(
    launch.revision
  );
});
it('publishes the exact committed launch revision and preserves rollback after accepted publication', async () => {
  const launch = await repository.putDraft('launch', 0, testLaunchData(), {});
  await repository.change(
    launch.id,
    (record) => {
      record.state = 'ARMED';
    },
    {},
    true
  );
  const committed = (await repository.find(launch.id, {}))!;
  expect(wake.wakeDropForge).toHaveBeenLastCalledWith({
    id: launch.id,
    revision: committed.revision
  });
  await expect(
    sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repository.change(
        launch.id,
        (record) => {
          record.state = 'PAUSED';
        },
        { connection },
        true
      );
      throw new Error('crash before commit');
    })
  ).rejects.toThrow('crash before commit');
  expect((await repository.find(launch.id, {}))!.revision).toBe(
    committed.revision
  );
  expect((await repository.find(launch.id, {}))!.state).toBe('ARMED');
});
it('does not persist an unqueued preparation job and commits a targeted dispatch revision on retry', async () => {
  const request = job();
  jest
    .mocked(wake.wakeDropForge)
    .mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(dropForgeJobsRepository.create(request, {})).rejects.toThrow(
    'queue unavailable'
  );
  await expect(dropForgeJobsRepository.find(request.id, {})).rejects.toThrow(
    'not found'
  );
  const saved = await dropForgeJobsRepository.create(request, {});
  expect(wake.wakeDropForge).toHaveBeenLastCalledWith(
    { id: saved.id, revision: saved.dispatch_revision },
    true
  );
});
it('processes and reports only the requested job when other jobs are pending', async () => {
  const first = await dropForgeJobsRepository.create(job(), {});
  const second = await dropForgeJobsRepository.create(job(), {});
  const process = jest.fn().mockResolvedValue({ normalized: true });
  await dropForgeJobsRepository.processOne(process, {}, second.id);
  expect(process).toHaveBeenCalledTimes(1);
  expect(process.mock.calls[0][0].id).toBe(second.id);
  expect((await dropForgeJobsRepository.find(first.id, {})).status).toBe(
    'PENDING'
  );
  await dropForgeJobsRepository.processOne(process, {}, second.id);
  expect(process).toHaveBeenCalledTimes(1);
  const report = jest.fn().mockResolvedValue({
    drop_id: 'report',
    pending_push_notification_ids: []
  });
  await dropForgeJobsRepository.reportOne(report, {}, second.id);
  await dropForgeJobsRepository.reportOne(report, {}, second.id);
  expect(report).toHaveBeenCalledTimes(1);
});
it('rolls back a multi-job reset if dispatching any report fails', async () => {
  const first = await dropForgeJobsRepository.create(
    { ...job(), kind: 'PROCESS_ALL' },
    {}
  );
  const second = await dropForgeJobsRepository.create(
    { ...job(), kind: 'PROCESS_ALL' },
    {}
  );
  await dropForgeJobsRepository.processOne(async () => ({}), {}, first.id);
  await dropForgeJobsRepository.processOne(async () => ({}), {}, second.id);
  jest
    .mocked(wake.wakeDropForge)
    .mockClear()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('second dispatch failed'));
  await expect(
    resetDistributionPreparation(testConfig.creator, 1, async () => undefined)
  ).rejects.toThrow('second dispatch failed');
  expect(wake.wakeDropForge).toHaveBeenCalledTimes(2);
  const savedJobs = await Promise.all(
    [first, second].map((original) =>
      dropForgeJobsRepository.find(original.id, {})
    )
  );
  savedJobs.forEach((saved, index) => {
    expect(saved.status).toBe('COMPLETED');
    expect(saved.dispatch_revision).toBe(
      [first, second][index].dispatch_revision
    );
  });
});
