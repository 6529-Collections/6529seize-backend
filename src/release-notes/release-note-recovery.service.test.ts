import { ReleaseNoteRecoveryJobEntity } from '@/entities/IReleaseNoteRecoveryJob';
import { ReleaseNoteGenerationRequest } from '@/release-notes/release-note-generation-queue';
import {
  DeferredReleaseNoteError,
  NonRetryableReleaseNoteError,
  NoReleaseNoteBaselineError,
  ReleaseNoteDependencyError,
  UntrustedReleaseNoteMetadataError
} from '@/release-notes/release-note-errors';
import { ReleaseNoteRecoveryDb } from '@/release-notes/release-note-recovery.db';
import { ReleaseNoteRecoveryService } from './release-note-recovery.service';

const request: ReleaseNoteGenerationRequest = {
  repo: '6529seize-frontend',
  workflow: 'Web Deploy - PROD',
  run_id: '39793832607',
  run_number: '1947',
  run_url: 'https://github.com/example/actions/runs/39793832607',
  sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  branch: 'main',
  environment: 'prod',
  service: 'web',
  prompt_path: 'ops/release-notes/release-notes.prompt.md',
  release_group_id: 'frontend-1947',
  release_group_services: ['web'],
  deployed_at: '2026-10-22T15:02:51.092Z'
};
const now = 1_792_758_000_000;
const job: ReleaseNoteRecoveryJobEntity = {
  publication_id: 'publication-1947',
  stream_key: 'stream',
  run_id: request.run_id,
  run_number: 1947,
  request_json: JSON.stringify(request),
  status: 'PENDING',
  failure_count: 0,
  next_attempt_at: now,
  last_error: null,
  alerted_at: null,
  created_at: now,
  updated_at: now
};
type Repository = Pick<
  ReleaseNoteRecoveryDb,
  | 'enqueue'
  | 'findDue'
  | 'findEarlier'
  | 'recordOutcome'
  | 'markAlerted'
  | 'deferAlert'
  | 'requestRetry'
>;

function setup(overrides: Partial<ReleaseNoteRecoveryJobEntity> = {}) {
  const saved = { ...job, ...overrides };
  const repository: jest.Mocked<Repository> = {
    enqueue: jest.fn().mockResolvedValue(saved),
    findDue: jest.fn().mockResolvedValue([saved]),
    findEarlier: jest.fn().mockResolvedValue(null),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
    markAlerted: jest.fn().mockResolvedValue(undefined),
    deferAlert: jest.fn().mockResolvedValue(undefined),
    requestRetry: jest.fn().mockResolvedValue(saved)
  };
  const postFailure = jest.fn().mockResolvedValue(undefined);
  const service = new ReleaseNoteRecoveryService(
    repository,
    postFailure,
    () => now
  );
  return { saved, repository, postFailure, service };
}

describe('ReleaseNoteRecoveryService', () => {
  it('never processes or acknowledges a request whose durable save failed', async () => {
    const { service, repository } = setup();
    repository.enqueue.mockRejectedValue(new Error('database unavailable'));
    const process = jest.fn();
    await expect(service.process(request, process, {})).rejects.toThrow(
      'database unavailable'
    );
    expect(process).not.toHaveBeenCalled();
  });

  it.each([
    'PUBLICATION_BLOCKED',
    'WORKFLOW_NOT_SETTLED',
    'PART_BUDGET_EXHAUSTED'
  ] as const)(
    'defers %s even after many SQS deliveries without counting a processing failure',
    async (reason) => {
      const { service, repository, postFailure } = setup();
      const process = jest
        .fn()
        .mockRejectedValue(
          new DeferredReleaseNoteError(reason, 'waiting for 1947')
        );
      for (let delivery = 0; delivery < 8; delivery++)
        await service.process(request, process, {});
      expect(repository.recordOutcome).toHaveBeenLastCalledWith(
        job.publication_id,
        {
          status: 'PENDING',
          failures: 0,
          nextAttemptAt: now + 300_000,
          lastError: 'waiting for 1947'
        },
        now,
        {}
      );
      expect(postFailure).not.toHaveBeenCalled();
    }
  );

  it('does not overtake a saved earlier run, even before its publication was prepared', async () => {
    const { service, repository } = setup({ run_number: 1948 });
    repository.findEarlier.mockResolvedValue(job);
    const process = jest.fn();
    await service.recoverDue(process, () => 180_000, {});
    expect(process).not.toHaveBeenCalled();
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      job.publication_id,
      expect.objectContaining({
        status: 'PENDING',
        failures: 0,
        lastError: expect.stringContaining('1947 must complete before run 1948')
      }),
      now,
      {}
    );
  });

  it('retains exhausted blockers and alerts once while continuing automatic recovery', async () => {
    const { service, repository, postFailure } = setup({ failure_count: 4 });
    const error = new Error('GitHub HTTP 500');
    await service.recoverDue(
      jest.fn().mockRejectedValue(error),
      () => 180_000,
      {}
    );
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      job.publication_id,
      {
        status: 'PENDING',
        failures: 5,
        nextAttemptAt: now + 960_000,
        lastError: error.message
      },
      now,
      {}
    );
    expect(postFailure).toHaveBeenCalledWith(request, error, 5);
    expect(repository.markAlerted).toHaveBeenCalled();
    const alreadyAlerted = setup({
      failure_count: 9,
      alerted_at: now - 60_000
    });
    await alreadyAlerted.service.recoverDue(
      jest.fn().mockRejectedValue(error),
      () => 180_000,
      {}
    );
    expect(alreadyAlerted.postFailure).not.toHaveBeenCalled();
    expect(alreadyAlerted.repository.recordOutcome).toHaveBeenCalledWith(
      job.publication_id,
      expect.objectContaining({
        status: 'PENDING',
        failures: 10,
        nextAttemptAt: now + 3_600_000
      }),
      now,
      {}
    );
  });

  it('honors dependency retry-after values longer than the exponential backoff', async () => {
    const { service, repository } = setup();
    await service.process(
      request,
      jest
        .fn()
        .mockRejectedValue(
          new ReleaseNoteDependencyError('rate limited', 7_200_000)
        ),
      {}
    );
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      job.publication_id,
      expect.objectContaining({ nextAttemptAt: now + 7_200_000 }),
      now,
      {}
    );
  });

  it('retries the stored envelope and completes without changing its identity', async () => {
    const { service, repository } = setup();
    const process = jest.fn().mockResolvedValue(undefined);
    await service.process(
      { ...request, triggered_by_github_login: 'different' },
      process,
      {}
    );
    expect(process).toHaveBeenCalledWith(request);
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      job.publication_id,
      { status: 'COMPLETED', failures: 0, nextAttemptAt: now, lastError: null },
      now,
      {}
    );
  });

  it.each(['COMPLETED', 'REJECTED'] as const)(
    'never republishes a %s job on duplicate delivery',
    async (status) => {
      const { service } = setup({ status });
      const process = jest.fn();
      await service.process(request, process, {});
      expect(process).not.toHaveBeenCalled();
    }
  );

  it('does not retry before the saved deadline', async () => {
    const { service } = setup({ next_attempt_at: now + 1000 });
    const process = jest.fn();
    await service.process(request, process, {});
    expect(process).not.toHaveBeenCalled();
  });

  it('keeps permanent failures available for explicit operator retry', async () => {
    const { service, repository, postFailure } = setup();
    const error = new NonRetryableReleaseNoteError(
      'release history requires review'
    );
    await service.process(request, jest.fn().mockRejectedValue(error), {});
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      job.publication_id,
      expect.objectContaining({ status: 'FAILED', failures: 1 }),
      now,
      {}
    );
    expect(postFailure).toHaveBeenCalledWith(request, error, 1);
  });

  it('retains a first deployment without a baseline without creating a permanent stream blocker', async () => {
    const { service, repository, postFailure } = setup();
    const error = new NoReleaseNoteBaselineError(
      'No previous successful production run'
    );
    await service.process(request, jest.fn().mockRejectedValue(error), {});
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      job.publication_id,
      expect.objectContaining({
        status: 'NO_BASELINE',
        lastError: error.message
      }),
      now,
      {}
    );
    expect(postFailure).toHaveBeenCalledWith(request, error, 1);
    expect(repository.markAlerted).toHaveBeenCalled();
  });

  it('retries the initial-baseline alert without trying to generate a missing publication range', async () => {
    const { service, repository, postFailure } = setup({
      status: 'NO_BASELINE',
      failure_count: 1
    });
    const process = jest.fn();
    await service.recoverDue(process, () => 180_000, {});
    expect(process).not.toHaveBeenCalled();
    expect(postFailure).toHaveBeenCalledWith(
      request,
      expect.any(NoReleaseNoteBaselineError),
      1
    );
    expect(repository.markAlerted).toHaveBeenCalled();
  });

  it('retries a failed terminal alert without trying to publish a permanent failure', async () => {
    const { service, postFailure, repository } = setup({
      status: 'FAILED',
      failure_count: 1,
      last_error: 'history error'
    });
    const process = jest.fn();
    await service.recoverDue(process, () => 180_000, {});
    expect(process).not.toHaveBeenCalled();
    expect(postFailure).toHaveBeenCalled();
    expect(repository.markAlerted).toHaveBeenCalled();
  });

  it('retries a thrown permanent-failure alert on subsequent polls until delivery succeeds', async () => {
    const { service, postFailure, repository, saved } = setup();
    const process = jest
      .fn()
      .mockRejectedValue(new NonRetryableReleaseNoteError('history error'));
    postFailure.mockRejectedValue(new Error('alert API unavailable'));
    await expect(service.process(request, process, {})).rejects.toThrow(
      'alert API unavailable'
    );
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      job.publication_id,
      expect.objectContaining({ status: 'FAILED', failures: 1 }),
      now,
      {}
    );
    expect(repository.markAlerted).not.toHaveBeenCalled();
    repository.findDue.mockResolvedValue([
      {
        ...saved,
        status: 'FAILED',
        failure_count: 1,
        last_error: 'history error'
      }
    ]);
    await expect(
      service.recoverDue(process, () => 180_000, {})
    ).resolves.toBeUndefined();
    expect(repository.markAlerted).not.toHaveBeenCalled();
    expect(repository.deferAlert).toHaveBeenCalledWith(
      job.publication_id,
      now + 300_000,
      now,
      {}
    );
    postFailure.mockResolvedValue(undefined);
    await service.recoverDue(process, () => 180_000, {});
    expect(postFailure).toHaveBeenCalledTimes(3);
    expect(process).toHaveBeenCalledTimes(1);
    expect(repository.markAlerted).toHaveBeenCalledWith(
      job.publication_id,
      now,
      {}
    );
  });

  it('rejects untrusted metadata without publishing a forged failure alert', async () => {
    const { service, repository, postFailure } = setup();
    await service.process(
      request,
      jest
        .fn()
        .mockRejectedValue(
          new UntrustedReleaseNoteMetadataError('SHA mismatch')
        ),
      {}
    );
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      job.publication_id,
      expect.objectContaining({ status: 'REJECTED' }),
      now,
      {}
    );
    expect(postFailure).not.toHaveBeenCalled();
  });

  it('continues other recovery jobs when a permanent failure alert cannot be delivered', async () => {
    const { service, repository, postFailure, saved } = setup({
      status: 'FAILED',
      failure_count: 1
    });
    const other = {
      ...job,
      publication_id: 'other-stream',
      stream_key: 'other-stream'
    };
    repository.findDue.mockResolvedValue([saved, other]);
    postFailure.mockRejectedValue(new Error('alert API unavailable'));
    const process = jest.fn().mockResolvedValue(undefined);
    await service.recoverDue(process, () => 180_000, {});
    expect(repository.deferAlert).toHaveBeenCalledWith(
      saved.publication_id,
      now + 300_000,
      now,
      {}
    );
    expect(process).toHaveBeenCalledTimes(1);
    expect(repository.recordOutcome).toHaveBeenCalledWith(
      'other-stream',
      expect.objectContaining({ status: 'COMPLETED' }),
      now,
      {}
    );
  });

  it('fails an unknown operator request outside the database transaction', async () => {
    const { service, repository } = setup();
    repository.requestRetry.mockResolvedValue(null);
    const process = jest.fn();
    await expect(service.retry('unknown', process, {})).rejects.toThrow(
      'does not exist'
    );
    expect(process).not.toHaveBeenCalled();
  });

  it('leaves due work untouched when the invocation budget is insufficient', async () => {
    const { service, repository } = setup();
    const process = jest.fn();
    await service.recoverDue(process, () => 44_999, {});
    expect(process).not.toHaveBeenCalled();
    expect(repository.recordOutcome).not.toHaveBeenCalled();
  });

  it('retries only the explicitly selected publication through the normal processor', async () => {
    const { service, repository } = setup();
    const process = jest.fn().mockResolvedValue(undefined);
    await service.retry(job.publication_id, process, {});
    expect(repository.requestRetry).toHaveBeenCalledWith(
      job.publication_id,
      now,
      {}
    );
    expect(repository.findDue).not.toHaveBeenCalled();
    expect(process).toHaveBeenCalledWith(request);
  });
});
