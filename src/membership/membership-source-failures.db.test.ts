import {
  IDENTITIES_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';
import { DbQueryOptions } from '@/db-query.options';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  MembershipPrimaryContext,
  membershipQueryOptions,
  withMembershipPrimaryTransaction
} from './membership-primary';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import {
  MembershipSourceJobIdentity,
  MembershipSourceJobsDb
} from './membership-source-jobs.db';
import {
  MembershipSourceStatesDb,
  withGlobalSourceKeys
} from './membership-source-states.db';
import { MembershipSourceKey } from './membership-validation';

const identity = anIdentity({ rep: 10 });
const profileKey: MembershipSourceKey = {
  scope: 'PROFILE',
  target_id: identity.profile_id!,
  dimension: 'RATINGS'
};
const job: MembershipSourceJobIdentity = {
  job_id: 'source-fault-cycle',
  keys: [profileKey]
};
const request = {
  scope: 'PROFILE' as const,
  target_id: identity.profile_id!,
  reason: 'fault-fixture'
};
const initial = { stage: 'INPUTS', after_id: null };
const next = { stage: 'DERIVED', after_id: 'page-1' };
const injectedFailure = new Error('INJECTED_MEMBERSHIP_WRITE_FAILURE');

const tx = <T>(operation: (ctx: MembershipPrimaryContext) => Promise<T>) =>
  withMembershipPrimaryTransaction(sqlExecutor, operation);
const jobs = () => new MembershipSourceJobsDb(() => sqlExecutor);
const sources = () => new MembershipSourceStatesDb(() => sqlExecutor);
const targets = () => new MembershipRefreshTargetsDb(() => sqlExecutor);

type WriteBoundary = {
  readonly name: string;
  readonly statement: string;
  readonly occurrence: number;
};

const sourceUpdate = `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE}`;
const jobInsert = `INSERT INTO ${MEMBERSHIP_SOURCE_JOBS_TABLE}`;
const jobUpdate = `UPDATE ${MEMBERSHIP_SOURCE_JOBS_TABLE}`;
const inputUpdate = `UPDATE ${IDENTITIES_TABLE}`;
const targetInsert = `INSERT INTO ${MEMBERSHIP_REFRESH_TARGETS_TABLE}`;

async function provision(): Promise<void> {
  await tx((ctx) =>
    sources().provision(
      withGlobalSourceKeys(job.keys),
      { bootstrap_id: 'fault-fixture', coverage_revision: 'test-only' },
      ctx
    )
  );
}

async function writeInput(ctx: MembershipPrimaryContext): Promise<void> {
  await sqlExecutor.execute(
    `${inputUpdate} SET rep = rep + 1 WHERE profile_id = :profileId`,
    { profileId: identity.profile_id },
    membershipQueryOptions(ctx)
  );
}

/** Observe actual persisted rows, including every key of the expanded job. */
async function snapshot() {
  return tx(async (ctx) => {
    const options = membershipQueryOptions(ctx);
    const states = await sources().read(
      withGlobalSourceKeys(job.keys),
      false,
      ctx
    );
    const receipts = await sqlExecutor.execute(
      `SELECT scope, target_id, dimension, status, progress,
         CAST(started_version AS CHAR) started_version,
         CAST(completed_version AS CHAR) completed_version
       FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
       WHERE job_id = :jobId ORDER BY scope, target_id, dimension`,
      { jobId: job.job_id },
      options
    );
    const input = await sqlExecutor.oneOrNull<{ rep: number }>(
      `SELECT rep FROM ${IDENTITIES_TABLE} WHERE profile_id = :profileId`,
      { profileId: identity.profile_id },
      options
    );
    return {
      states: states.map(({ key, state }) => ({
        key,
        version: state?.version,
        active_jobs: state?.active_jobs
      })),
      receipts,
      input,
      target: await targets().find(request, ctx)
    };
  });
}

/** Forward to MySQL first, then simulate loss/failure immediately after that write. */
async function failAfterRealWrite(
  boundary: WriteBoundary,
  operation: (ctx: MembershipPrimaryContext) => Promise<unknown>,
  catchInsideTransaction = false
): Promise<void> {
  const execute = sqlExecutor.execute.bind(sqlExecutor);
  let matchingWrites = 0;
  let injected = false;
  const spy = jest
    .spyOn(sqlExecutor, 'execute')
    .mockImplementation(
      async <T>(
        sql: string,
        params?: Record<string, unknown>,
        options?: DbQueryOptions
      ): Promise<T[]> => {
        const result = await execute<T>(sql, params, options);
        if (sql.trimStart().startsWith(boundary.statement)) {
          matchingWrites += 1;
          if (matchingWrites === boundary.occurrence) {
            injected = true;
            throw injectedFailure;
          }
        }
        return result;
      }
    );
  try {
    await expect(
      tx(async (ctx) => {
        try {
          await operation(ctx);
        } catch (error) {
          if (!catchInsideTransaction) throw error;
          // Even a caller swallowing the error must not commit partial inputs.
          expect(error).toBe(injectedFailure);
        }
      })
    ).rejects.toBe(injectedFailure);
  } finally {
    spy.mockRestore();
  }
  expect(injected).toBe(true);
  expect(matchingWrites).toBe(boundary.occurrence);
}

describeWithSeed(
  'Membership source job failures after real MySQL writes',
  withIdentities([identity]),
  () => {
    it.each<WriteBoundary>([
      { name: 'first source barrier', statement: sourceUpdate, occurrence: 1 },
      { name: 'last source barrier', statement: sourceUpdate, occurrence: 2 },
      { name: 'first job receipt', statement: jobInsert, occurrence: 1 },
      { name: 'last job receipt', statement: jobInsert, occurrence: 2 }
    ])('rolls back start after $name', async (boundary) => {
      await provision();
      const before = await snapshot();
      await failAfterRealWrite(boundary, (ctx) =>
        jobs().start(job, initial, ctx)
      );
      expect(await snapshot()).toEqual(before);
      const restarted = await tx((ctx) => jobs().start(job, initial, ctx));
      expect(restarted.progress.revision).toBe('0');
      expect((await snapshot()).states.map((row) => row.active_jobs)).toEqual([
        1, 1
      ]);
    });

    it.each<WriteBoundary>([
      { name: 'source input', statement: inputUpdate, occurrence: 1 },
      { name: 'first progress receipt', statement: jobUpdate, occurrence: 1 },
      { name: 'last progress receipt', statement: jobUpdate, occurrence: 2 }
    ])(
      'rolls back checkpoint after $name and retries once',
      async (boundary) => {
        await provision();
        const started = await tx((ctx) => jobs().start(job, initial, ctx));
        const before = await snapshot();
        await failAfterRealWrite(boundary, (ctx) =>
          jobs().checkpoint(job, started.progress, next, writeInput, ctx)
        );
        expect(await snapshot()).toEqual(before);
        const retry = await tx((ctx) =>
          jobs().checkpoint(job, started.progress, next, writeInput, ctx)
        );
        expect(retry.applied).toBe(true);
        expect(retry.state.progress.revision).toBe('1');
        expect((await snapshot()).input).toEqual({ rep: 11 });
      }
    );

    it.each<WriteBoundary>([
      { name: 'final input', statement: inputUpdate, occurrence: 1 },
      {
        name: 'first source decrement',
        statement: sourceUpdate,
        occurrence: 1
      },
      { name: 'last source decrement', statement: sourceUpdate, occurrence: 2 },
      { name: 'first completion receipt', statement: jobUpdate, occurrence: 1 },
      { name: 'last completion receipt', statement: jobUpdate, occurrence: 2 },
      { name: 'refresh request', statement: targetInsert, occurrence: 1 }
    ])(
      'rolls back completion after $name and safely retries',
      async (boundary) => {
        await provision();
        const started = await tx((ctx) => jobs().start(job, initial, ctx));
        const before = await snapshot();
        await failAfterRealWrite(boundary, (ctx) =>
          jobs().complete(job, started.progress, [request], writeInput, ctx)
        );
        expect(await snapshot()).toEqual(before);
        await tx((ctx) =>
          jobs().complete(job, started.progress, [request], writeInput, ctx)
        );
        const completed = await snapshot();
        expect(completed.input).toEqual({ rep: 11 });
        expect(
          completed.states.map((row) => [row.version, row.active_jobs])
        ).toEqual([
          ['2', 0],
          ['2', 0]
        ]);
        expect(completed.target?.requested_version).toBe('1');
      }
    );

    it('aborts the outer transaction even if its owner catches a mid-completion failure', async () => {
      await provision();
      const started = await tx((ctx) => jobs().start(job, initial, ctx));
      const before = await snapshot();
      await failAfterRealWrite(
        {
          name: 'first completion receipt',
          statement: jobUpdate,
          occurrence: 1
        },
        (ctx) =>
          jobs().complete(job, started.progress, [request], writeInput, ctx),
        true
      );
      expect(await snapshot()).toEqual(before);
    });

    it('rejects inconsistent revisions across the same bound job before any input write', async () => {
      await provision();
      const started = await tx((ctx) => jobs().start(job, initial, ctx));
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_JOBS_TABLE}
         SET progress = JSON_SET(progress, '$.revision', '7')
         WHERE job_id = :jobId AND scope = 'PROFILE'`,
        { jobId: job.job_id }
      );
      const before = await snapshot();
      const write = jest.fn(writeInput);
      await expect(
        tx((ctx) =>
          jobs().complete(job, started.progress, [request], write, ctx)
        )
      ).rejects.toThrow('Inconsistent membership producer job set');
      expect(write).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    });

    it('rejects a source version changed during a running job without clearing either barrier', async () => {
      await provision();
      const started = await tx((ctx) => jobs().start(job, initial, ctx));
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE}
         SET version = version + 1 WHERE scope = 'PROFILE' AND target_id = :profileId`,
        { profileId: identity.profile_id }
      );
      const before = await snapshot();
      const write = jest.fn(writeInput);
      await expect(
        tx((ctx) =>
          jobs().complete(job, started.progress, [request], write, ctx)
        )
      ).rejects.toThrow('barrier was superseded');
      expect(write).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    });

    it('keeps source and checkpoint versions exact above the safe integer range', async () => {
      await provision();
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version = '9007199254740993'`
      );
      await tx((ctx) => jobs().start(job, initial, ctx));
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_JOBS_TABLE}
         SET progress = JSON_SET(progress, '$.revision', '9007199254740993')
         WHERE job_id = :jobId`,
        { jobId: job.job_id }
      );
      const resumed = await tx((ctx) => jobs().start(job, initial, ctx));
      const checkpoint = await tx((ctx) =>
        jobs().checkpoint(job, resumed.progress, next, writeInput, ctx)
      );
      expect(checkpoint.state.progress.revision).toBe('9007199254740994');
      await tx((ctx) =>
        jobs().complete(
          job,
          checkpoint.state.progress,
          [request],
          writeInput,
          ctx
        )
      );
      const completed = await snapshot();
      expect(completed.states.map((row) => row.version)).toEqual([
        '9007199254740995',
        '9007199254740995'
      ]);
      expect(completed.input).toEqual({ rep: 12 });
      expect(
        (await tx((ctx) => jobs().start(job, initial, ctx))).progress.revision
      ).toBe('9007199254740995');
    });
  }
);
