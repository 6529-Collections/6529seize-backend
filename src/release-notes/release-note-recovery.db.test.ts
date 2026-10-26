import { RELEASE_NOTE_RECOVERY_JOBS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ReleaseNoteGenerationRequest } from '@/release-notes/release-note-generation-queue';
import {
  ReleaseNoteRecoveryDb,
  recoveryStreamKey
} from './release-note-recovery.db';

const request: ReleaseNoteGenerationRequest = {
  repo: '6529seize-frontend',
  workflow: 'Web Deploy - PROD',
  run_id: '39793832607',
  run_number: '1947',
  run_url: 'https://github.com/example/actions/runs/39793832607',
  sha: 'abc123',
  branch: 'main',
  environment: 'prod',
  service: 'web',
  prompt_path: 'ops/release-notes/release-notes.prompt.md',
  release_group_id: 'frontend-1947',
  release_group_services: ['web'],
  deployed_at: '2026-10-22T15:02:51.092Z'
};

describeWithSeed(
  'ReleaseNoteRecoveryDb',
  { table: RELEASE_NOTE_RECOVERY_JOBS_TABLE, rows: [] },
  () => {
    const db = new ReleaseNoteRecoveryDb(() => sqlExecutor);

    it('selects only the next pending publication in the completed jobs stream', async () => {
      const first = await db.enqueue('first', request, 1000, {});
      await db.enqueue(
        'third',
        { ...request, run_number: '1949', run_id: 'third' },
        2000,
        {}
      );
      await db.enqueue(
        'other-stream',
        { ...request, workflow: 'Another workflow', run_number: '1948' },
        2000,
        {}
      );
      await db.enqueue(
        'second',
        { ...request, run_number: '1948', run_id: 'second' },
        3000,
        {}
      );
      expect((await db.findNextPending(first, {}))?.publication_id).toBe(
        'second'
      );
      await db.recordOutcome(
        'second',
        {
          status: 'COMPLETED',
          failures: 0,
          nextAttemptAt: 4000,
          lastError: null
        },
        4000,
        {}
      );
      expect((await db.findNextPending(first, {}))?.publication_id).toBe(
        'third'
      );
      await db.recordOutcome(
        'third',
        {
          status: 'COMPLETED',
          failures: 0,
          nextAttemptAt: 4000,
          lastError: null
        },
        4000,
        {}
      );
      expect(await db.findNextPending(first, {})).toBeNull();
    });

    it('preserves the original envelope, retry deadline and attempts across duplicate deliveries', async () => {
      await db.enqueue('publication', request, 1000, {});
      await db.recordOutcome(
        'publication',
        {
          status: 'PENDING',
          failures: 5,
          nextAttemptAt: 9000,
          lastError: 'GitHub 500'
        },
        2000,
        {}
      );
      const saved = await db.enqueue(
        'publication',
        { ...request, sha: 'changed' },
        3000,
        {}
      );
      expect(JSON.parse(saved.request_json)).toEqual(request);
      expect(saved.failure_count).toBe(5);
      expect(Number(saved.next_attempt_at)).toBe(9000);
      expect(await db.findDue(8999, {})).toEqual([]);
      expect((await db.findDue(9000, {})).map((j) => j.publication_id)).toEqual(
        ['publication']
      );
    });

    it('keeps later jobs blocked by the earlier stream head even while its retry is delayed', async () => {
      const earlier = await db.enqueue('earlier', request, 1000, {});
      const newer = await db.enqueue(
        'newer',
        {
          ...request,
          repo: '6529-Collections/6529seize-frontend',
          run_id: '39818018345',
          run_number: '1948',
          sha: 'next'
        },
        2000,
        {}
      );
      await db.recordOutcome(
        'earlier',
        {
          status: 'PENDING',
          failures: 5,
          nextAttemptAt: 99999,
          lastError: 'error'
        },
        3000,
        {}
      );
      expect((await db.findEarlier(newer, {}))?.publication_id).toBe(
        earlier.publication_id
      );
      await db.recordOutcome(
        'earlier',
        {
          status: 'COMPLETED',
          failures: 5,
          nextAttemptAt: 4000,
          lastError: null
        },
        4000,
        {}
      );
      expect(await db.findEarlier(newer, {})).toBeNull();
    });

    it('does not block unrelated workflow streams or rejected metadata', async () => {
      await db.enqueue('frontend', request, 1000, {});
      const other = await db.enqueue(
        'other',
        {
          ...request,
          workflow: 'Another workflow',
          run_id: '999',
          run_number: '1948'
        },
        1000,
        {}
      );
      expect(await db.findEarlier(other, {})).toBeNull();
      await db.recordOutcome(
        'frontend',
        {
          status: 'REJECTED',
          failures: 1,
          nextAttemptAt: 2000,
          lastError: 'untrusted'
        },
        2000,
        {}
      );
      expect(await db.findDue(3000, {})).toEqual([
        expect.objectContaining({ publication_id: 'other' })
      ]);
    });

    it('allows a later deploy to bootstrap after the first stream run had no baseline', async () => {
      await db.enqueue('initial', request, 1000, {});
      await db.recordOutcome(
        'initial',
        {
          status: 'NO_BASELINE',
          failures: 1,
          nextAttemptAt: 2000,
          lastError: 'No previous run'
        },
        2000,
        {}
      );
      const newer = await db.enqueue(
        'newer',
        { ...request, run_number: '1948', run_id: '39818018345' },
        3000,
        {}
      );
      expect(await db.findEarlier(newer, {})).toBeNull();
      expect(
        (await db.findDue(3000, {})).map((j) => j.publication_id)
      ).toContain('initial');
      await db.markAlerted('initial', 3000, {});
      expect(
        (await db.findDue(3000, {})).map((j) => j.publication_id)
      ).not.toContain('initial');
      expect((await db.enqueue('initial', request, 4000, {})).status).toBe(
        'NO_BASELINE'
      );
    });

    it('retains permanent blockers and retries their failed alert separately', async () => {
      await db.enqueue('publication', request, 1000, {});
      await db.recordOutcome(
        'publication',
        {
          status: 'FAILED',
          failures: 1,
          nextAttemptAt: 2000,
          lastError: 'history'
        },
        2000,
        {}
      );
      expect((await db.findDue(2000, {}))[0].status).toBe('FAILED');
      await db.deferAlert('publication', 3000, 2500, {});
      expect(await db.findDue(2999, {})).toEqual([]);
      expect((await db.findDue(3000, {}))[0].status).toBe('FAILED');
      await db.markAlerted('publication', 3500, {});
      expect(await db.findDue(3500, {})).toEqual([]);
      const newer = await db.enqueue(
        'newer',
        { ...request, run_number: '1948' },
        3500,
        {}
      );
      expect((await db.findEarlier(newer, {}))?.publication_id).toBe(
        'publication'
      );
      const saved = await db.requestRetry('publication', 4000, {});
      expect(saved).toEqual(
        expect.objectContaining({
          status: 'PENDING',
          alerted_at: null,
          failure_count: 0,
          request_json: JSON.stringify(request)
        })
      );
    });

    it('never resets completed jobs and fails clearly for an unknown operator retry', async () => {
      await db.enqueue('publication', request, 1000, {});
      await db.recordOutcome(
        'publication',
        {
          status: 'COMPLETED',
          failures: 0,
          nextAttemptAt: 2000,
          lastError: null
        },
        2000,
        {}
      );
      expect((await db.requestRetry('publication', 3000, {}))?.status).toBe(
        'COMPLETED'
      );
      expect((await db.enqueue('publication', request, 4000, {})).status).toBe(
        'COMPLETED'
      );
      await expect(db.requestRetry('unknown', 3000, {})).resolves.toBeNull();
    });
  }
);

describe('Recovery request validation', () => {
  it('canonicalizes workflow and repository aliases without merging case-sensitive branches', () => {
    expect(recoveryStreamKey(request)).toBe(
      recoveryStreamKey({
        ...request,
        repo: '6529-Collections/6529seize-frontend',
        workflow: ' WEB DEPLOY - PROD ',
        environment: 'PROD'
      })
    );
    expect(recoveryStreamKey({ ...request, branch: 'Main' })).not.toBe(
      recoveryStreamKey(request)
    );
    expect(
      recoveryStreamKey({
        ...request,
        repo: '6529-Collections/6529-CORE',
        branch: 'v0.3.1'
      })
    ).toBe(
      recoveryStreamKey({ ...request, repo: '6529-core', branch: 'v0.3.2' })
    );
  });
  it.each([undefined, null, '', 'NaN', '-1', '0', '1.5', '4294967296'])(
    'rejects invalid run number %s before opening a database transaction',
    async (runNumber) => {
      const supplier = jest.fn();
      const db = new ReleaseNoteRecoveryDb(supplier);
      await expect(
        db.enqueue('invalid', { ...request, run_number: runNumber }, 1000, {})
      ).rejects.toThrow('valid GitHub run number');
      expect(supplier).not.toHaveBeenCalled();
    }
  );
});
