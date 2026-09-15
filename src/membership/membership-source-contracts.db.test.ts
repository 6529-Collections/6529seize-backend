import {
  IDENTITIES_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';
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
  MembershipSourceJobsDb,
  MembershipSourceJobIdentity
} from './membership-source-jobs.db';
import {
  MEMBERSHIP_CATALOG_KEY,
  MembershipSourceStatesDb,
  withGlobalSourceKeys
} from './membership-source-states.db';
import { MembershipSourceKey } from './membership-validation';

const identity = anIdentity({ rep: 1 });
const profileKey: MembershipSourceKey = {
  scope: 'PROFILE',
  target_id: identity.profile_id!,
  dimension: 'RATINGS'
};
const globalKey: MembershipSourceKey = {
  scope: 'GLOBAL',
  target_id: '*',
  dimension: 'RATINGS'
};
const request = {
  scope: 'PROFILE' as const,
  target_id: identity.profile_id!,
  reason: 'ratings'
};
const initial = { stage: 'RATINGS', after_id: null };
const finished = { stage: 'INPUTS_COMMITTED', after_id: null };
const job: MembershipSourceJobIdentity = {
  job_id: 'cycle-1',
  keys: [profileKey]
};
const sources = () => new MembershipSourceStatesDb(() => sqlExecutor);
const jobs = () => new MembershipSourceJobsDb(() => sqlExecutor);
const targets = () => new MembershipRefreshTargetsDb(() => sqlExecutor);
const tx = <T>(fn: (ctx: MembershipPrimaryContext) => Promise<T>) =>
  withMembershipPrimaryTransaction(sqlExecutor, fn);
const provision = (
  keys: readonly MembershipSourceKey[] = [profileKey, globalKey]
) =>
  tx((ctx) =>
    sources().provision(
      keys,
      { bootstrap_id: 'test', coverage_revision: 'fixture-only' },
      ctx
    )
  );
const state = () =>
  tx((ctx) => sources().read([profileKey, globalKey], false, ctx));
const getTarget = () => tx((ctx) => targets().find(request, ctx));
const readRep = () =>
  sqlExecutor.oneOrNull<{ rep: number }>(
    `SELECT rep FROM ${IDENTITIES_TABLE} WHERE profile_id = :id`,
    { id: identity.profile_id }
  );
const writeRep = (ctx: MembershipPrimaryContext) =>
  sqlExecutor.execute(
    `UPDATE ${IDENTITIES_TABLE} SET rep = rep + 1 WHERE profile_id = :id`,
    { id: identity.profile_id },
    membershipQueryOptions(ctx)
  );
const mutate = (ctx: MembershipPrimaryContext) =>
  sources().mutate({ keys: [profileKey], requests: [request] }, writeRep, ctx);

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeWithSeed(
  'Membership source transaction contracts',
  withIdentities([identity]),
  () => {
    it('keeps absent evidence unknown and refuses mutation or jobs without provisioning', async () => {
      expect((await state()).every((row) => row.state === null)).toBe(true);
      await expect(tx(mutate)).rejects.toThrow('evidence');
      await expect(
        tx((ctx) => jobs().start(job, initial, ctx))
      ).rejects.toThrow('evidence');
      expect(await readRep()).toEqual({ rep: 1 });
      expect(await getTarget()).toBeNull();
    });

    it('requires global evidence for a profile mutation without inventing global version zero', async () => {
      await provision([profileKey]);
      await expect(tx(mutate)).rejects.toThrow('evidence');
      expect(
        (await state()).find((row) => row.key.scope === 'GLOBAL')?.state
      ).toBeNull();
    });

    it('treats a source row without a validated bootstrap receipt as unknown', async () => {
      await provision();
      await sqlExecutor.execute(
        `DELETE FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE} WHERE scope = 'PROFILE'`
      );
      expect(
        (await state()).find((row) => row.key.scope === 'PROFILE')?.provisioned
      ).toBe(false);
      await expect(
        tx((ctx) => sources().capture([profileKey], false, ctx))
      ).rejects.toThrow('evidence');
      await expect(tx(mutate)).rejects.toThrow('evidence');
      await expect(
        tx((ctx) => jobs().start(job, initial, ctx))
      ).rejects.toThrow('evidence');
      await expect(provision()).rejects.toThrow('evidence');
      expect(await readRep()).toEqual({ rep: 1 });
    });

    it('records explicit bootstrap evidence once and does not reset existing counters', async () => {
      await provision();
      await tx(mutate);
      await provision();
      expect((await state()).map((row) => row.state?.version)).toEqual([
        '0',
        '1'
      ]);
      const receipts = await sqlExecutor.execute<{
        status: string;
        progress: string;
      }>(`SELECT status, progress FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}`);
      expect(receipts).toHaveLength(2);
      expect(receipts.every((row) => row.status === 'COMPLETED')).toBe(true);
    });

    it.each(['input', 'version', 'target'])(
      'rolls back source inputs, version and target after the %s write boundary',
      async (boundary) => {
        await provision();
        const execute = sqlExecutor.execute.bind(sqlExecutor);
        const table =
          boundary === 'input'
            ? IDENTITIES_TABLE
            : boundary === 'version'
              ? MEMBERSHIP_SOURCE_STATES_TABLE
              : MEMBERSHIP_REFRESH_TARGETS_TABLE;
        const statement = new RegExp(`^(UPDATE|INSERT INTO) ${table}\\b`);
        const spy = jest
          .spyOn(sqlExecutor, 'execute')
          .mockImplementation(async (sql, params, options) => {
            const result = await execute(sql, params, options);
            if (statement.test(sql.trim())) throw new Error('injected');
            return result;
          });
        try {
          await expect(tx(mutate)).rejects.toThrow('injected');
        } finally {
          spy.mockRestore();
        }
        expect(await readRep()).toEqual({ rep: 1 });
        expect((await state()).map((row) => row.state?.version)).toEqual([
          '0',
          '0'
        ]);
        expect(await getTarget()).toBeNull();
      }
    );

    it('rolls back successful source writes when a later logic error is caught', async () => {
      await provision();
      await expect(
        tx(async (ctx) => {
          await mutate(ctx);
          try {
            await targets().request(
              [{ ...request, reason: 'invalid reason' }],
              ctx
            );
          } catch {
            return 'caller swallowed validation error';
          }
          return 'unexpected success';
        })
      ).rejects.toThrow('Invalid membership refresh reason');
      expect(await readRep()).toEqual({ rep: 1 });
      expect((await state()).map((row) => row.state?.version)).toEqual([
        '0',
        '0'
      ]);
      expect(await getTarget()).toBeNull();
    });

    it('retains newer request state and reactivates parked work without losing exact counters', async () => {
      await tx((ctx) => targets().request([request], ctx));
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET requested_version='9007199254740993', completed_version='9007199254740992', active_run_id='11111111-1111-1111-1111-111111111111', available_at_millis=NULL, attempts=8, last_error='parked'`
      );
      await tx((ctx) => targets().request([request, request], ctx));
      expect(await getTarget()).toMatchObject({
        requested_version: '9007199254740994',
        completed_version: '9007199254740992',
        active_run_id: '11111111-1111-1111-1111-111111111111',
        attempts: 0,
        last_error: null
      });
      expect((await getTarget())?.available_at_millis).not.toBeNull();
    });

    it('rolls source inputs back when a refresh counter cannot increment', async () => {
      await provision();
      await tx((ctx) => targets().request([request], ctx));
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE} SET requested_version='9223372036854775807'`
      );
      await expect(tx(mutate)).rejects.toBeDefined();
      expect(await readRep()).toEqual({ rep: 1 });
      expect((await state()).map((row) => row.state?.version)).toEqual([
        '0',
        '0'
      ]);
      expect((await getTarget())?.requested_version).toBe(
        '9223372036854775807'
      );
    });

    it('commits actual input changes with exact counters above the safe integer range', async () => {
      await provision();
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version = '9007199254740993'`
      );
      await tx(mutate);
      expect(await readRep()).toEqual({ rep: 2 });
      expect((await state()).map((row) => row.state?.version)).toEqual([
        '9007199254740993',
        '9007199254740994'
      ]);
      expect((await getTarget())?.requested_version).toBe('1');
    });

    it('coalesces concurrent source transactions with reverse caller key order', async () => {
      await provision();
      await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          tx((ctx) =>
            sources().mutate(
              {
                keys: i % 2 ? [profileKey, globalKey] : [globalKey, profileKey],
                requests: [request]
              },
              writeRep,
              ctx
            )
          )
        )
      );
      expect(await readRep()).toEqual({ rep: 5 });
      expect((await state()).map((row) => row.state?.version)).toEqual([
        '4',
        '4'
      ]);
      expect((await getTarget())?.requested_version).toBe('4');
    });

    it.each(['mutation', 'completion'])(
      'coalesces a request-only transaction while %s holds source locks',
      async (mode) => {
        await provision();
        const started =
          mode === 'completion'
            ? await tx((ctx) => jobs().start(job, initial, ctx))
            : null;
        const held = latch();
        const release = latch();
        const waiting = latch();
        const requestOnly = tx(async (ctx) => {
          await targets().request([request], ctx);
          held.resolve();
          await release.promise;
        });
        await Promise.race([held.promise, requestOnly]);
        const execute = sqlExecutor.execute.bind(sqlExecutor);
        const spy = jest
          .spyOn(sqlExecutor, 'execute')
          .mockImplementation(async (sql, params, options) => {
            if (
              sql
                .trim()
                .startsWith(`INSERT INTO ${MEMBERSHIP_REFRESH_TARGETS_TABLE}`)
            ) {
              waiting.resolve();
            }
            return execute(sql, params, options);
          });
        const producer = tx(async (ctx) => {
          if (started) {
            await jobs().complete(
              job,
              started.progress,
              [request],
              writeRep,
              ctx
            );
          } else {
            await mutate(ctx);
          }
        });
        let outcomes: PromiseSettledResult<void>[] = [];
        try {
          // This upsert is issued after the producer acquired source/input locks,
          // while an independent request-only transaction still owns the target.
          await Promise.race([waiting.promise, producer]);
        } finally {
          release.resolve();
          outcomes = await Promise.allSettled([requestOnly, producer]);
          spy.mockRestore();
        }
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') throw outcome.reason;
        }
        expect(await readRep()).toEqual({ rep: 2 });
        expect((await getTarget())?.requested_version).toBe('2');
        expect(
          (await state()).every((row) => row.state?.active_jobs === 0)
        ).toBe(true);
      }
    );

    it('hides uncommitted source/version/request changes from another primary snapshot', async () => {
      await provision();
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = tx(async (ctx) => {
        await mutate(ctx);
        entered();
        await blocked;
      });
      await ready;
      try {
        expect(await readRep()).toEqual({ rep: 1 });
        expect((await state()).map((row) => row.state?.version)).toEqual([
          '0',
          '0'
        ]);
        expect(await getTarget()).toBeNull();
      } finally {
        release();
      }
      await pending;
      expect(await readRep()).toEqual({ rep: 2 });
    });

    it('versions catalogue changes, deletions and recreations atomically', async () => {
      await provision([MEMBERSHIP_CATALOG_KEY]);
      for (const is_deleted of [false, true, false]) {
        await tx((ctx) =>
          sources().mutate(
            {
              keys: [MEMBERSHIP_CATALOG_KEY],
              requests: [
                { scope: 'GROUP', target_id: 'group-a', reason: 'rule' }
              ],
              group_changes: [{ group_id: 'group-a', is_deleted }]
            },
            async () => undefined,
            ctx
          )
        );
      }
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT CAST(catalog_version AS CHAR) version, is_deleted FROM ${MEMBERSHIP_GROUP_VERSIONS_TABLE} WHERE group_id = 'group-a'`
        )
      ).toEqual({ version: '3', is_deleted: false });
      await expect(
        tx((ctx) =>
          sources().mutate(
            { keys: [MEMBERSHIP_CATALOG_KEY], requests: [request] },
            async () => undefined,
            ctx
          )
        )
      ).rejects.toThrow('group-version evidence');
      await expect(
        tx((ctx) =>
          jobs().start(
            { job_id: 'catalog', keys: [MEMBERSHIP_CATALOG_KEY] },
            initial,
            ctx
          )
        )
      ).rejects.toThrow('catalogue jobs');
    });

    it('holds the source barrier until the same durable cycle completes, exactly once', async () => {
      await provision();
      const started = await tx((ctx) => jobs().start(job, initial, ctx));
      expect(await tx((ctx) => jobs().start(job, initial, ctx))).toEqual(
        started
      );
      expect((await state()).map((row) => row.state?.active_jobs)).toEqual([
        1, 1
      ]);
      await expect(
        tx((ctx) => sources().capture([profileKey], false, ctx))
      ).rejects.toThrow('evidence');
      await expect(tx(mutate)).rejects.toThrow('evidence');
      const checkpoint = await tx((ctx) =>
        jobs().checkpoint(job, started.progress, finished, writeRep, ctx)
      );
      expect(checkpoint.applied).toBe(true);
      const completed = await Promise.all(
        [1, 2].map(() =>
          tx((ctx) =>
            jobs().complete(
              job,
              checkpoint.state.progress,
              [request],
              writeRep,
              ctx
            )
          )
        )
      );
      expect(completed.filter((result) => result.applied)).toHaveLength(1);
      expect(await readRep()).toEqual({ rep: 3 });
      expect(
        (await state()).map((row) => [
          row.state?.version,
          row.state?.active_jobs
        ])
      ).toEqual([
        ['2', 0],
        ['2', 0]
      ]);
      expect((await getTarget())?.requested_version).toBe('1');
      expect((await tx((ctx) => jobs().start(job, initial, ctx))).status).toBe(
        'COMPLETED'
      );
    });

    it('serializes GLOBAL and PROFILE jobs and prevents a delayed old completion clearing the new job', async () => {
      await provision();
      const old = await tx((ctx) => jobs().start(job, initial, ctx));
      const globalJob = { job_id: 'global-cycle', keys: [globalKey] };
      await expect(
        tx((ctx) => jobs().start(globalJob, initial, ctx))
      ).rejects.toThrow('evidence');
      await tx((ctx) =>
        jobs().complete(
          job,
          old.progress,
          [request],
          async () => undefined,
          ctx
        )
      );
      await tx((ctx) => jobs().start(globalJob, initial, ctx));
      const delayed = await tx((ctx) =>
        jobs().complete(job, old.progress, [request], writeRep, ctx)
      );
      expect(delayed.applied).toBe(false);
      expect(
        (await state()).map((row) => [
          row.state?.version,
          row.state?.active_jobs
        ])
      ).toEqual([
        ['3', 1],
        ['2', 0]
      ]);
      await expect(tx(mutate)).rejects.toThrow('evidence');
      expect(await readRep()).toEqual({ rep: 1 });
      expect((await getTarget())?.requested_version).toBe('1');
    });

    it('retains FAILED barriers and fences stale writes/completions through repair', async () => {
      await provision();
      const started = await tx((ctx) => jobs().start(job, initial, ctx));
      const failed = await tx((ctx) =>
        jobs().fail(job, started.progress, 'SOURCE_FAILED', ctx)
      );
      expect((await state()).map((row) => row.state?.active_jobs)).toEqual([
        1, 1
      ]);
      await expect(
        tx((ctx) =>
          jobs().complete(job, failed.progress, [request], writeRep, ctx)
        )
      ).rejects.toThrow('not running');
      const resumed = await tx((ctx) =>
        jobs().resume(job, failed.progress, ctx)
      );
      expect(resumed.progress.revision).toBe('2');
      await expect(
        tx((ctx) => jobs().fail(job, started.progress, 'DELAYED_FAILURE', ctx))
      ).rejects.toThrow('superseded');
      await expect(
        tx((ctx) =>
          jobs().complete(job, started.progress, [request], writeRep, ctx)
        )
      ).rejects.toThrow('superseded');
      await tx((ctx) =>
        jobs().complete(job, resumed.progress, [request], writeRep, ctx)
      );
      expect(await readRep()).toEqual({ rep: 2 });
    });

    it('replays a checkpoint without writes and rejects an ABA stage/cursor replay', async () => {
      await provision();
      const started = await tx((ctx) => jobs().start(job, initial, ctx));
      const first = await tx((ctx) =>
        jobs().checkpoint(job, started.progress, finished, writeRep, ctx)
      );
      expect(
        (
          await tx((ctx) =>
            jobs().checkpoint(job, started.progress, finished, writeRep, ctx)
          )
        ).applied
      ).toBe(false);
      const second = await tx((ctx) =>
        jobs().checkpoint(job, first.state.progress, initial, writeRep, ctx)
      );
      expect(second.state.progress.revision).toBe('2');
      await expect(
        tx((ctx) =>
          jobs().checkpoint(job, started.progress, finished, writeRep, ctx)
        )
      ).rejects.toThrow('superseded');
      expect(await readRep()).toEqual({ rep: 3 });
    });

    it('rejects a changed durable source set before applying any producer writes', async () => {
      const extra: MembershipSourceKey = {
        ...profileKey,
        dimension: 'IDENTITY'
      };
      await provision(withGlobalSourceKeys([profileKey, extra]));
      const full = { ...job, keys: [profileKey, extra] };
      const started = await tx((ctx) => jobs().start(full, initial, ctx));
      await expect(
        tx((ctx) =>
          jobs().complete(job, started.progress, [request], writeRep, ctx)
        )
      ).rejects.toThrow('Invalid membership producer state');
      expect(await readRep()).toEqual({ rep: 1 });
    });

    it('rolls back a source job start and a final input write with all counters', async () => {
      await provision();
      await expect(
        tx(async (ctx) => {
          await jobs().start(job, initial, ctx);
          throw new Error('start-crash');
        })
      ).rejects.toThrow('start-crash');
      expect((await state()).map((row) => row.state?.version)).toEqual([
        '0',
        '0'
      ]);
      const started = await tx((ctx) => jobs().start(job, initial, ctx));
      await expect(
        tx(async (ctx) => {
          await jobs().complete(
            job,
            started.progress,
            [request],
            writeRep,
            ctx
          );
          throw new Error('finish-crash');
        })
      ).rejects.toThrow('finish-crash');
      expect(
        (await state()).map((row) => [
          row.state?.version,
          row.state?.active_jobs
        ])
      ).toEqual([
        ['1', 1],
        ['1', 1]
      ]);
      expect(await readRep()).toEqual({ rep: 1 });
      expect(await getTarget()).toBeNull();
    });
    it('completes a TDH/xTDH cycle only after the separate statistics activation', async () => {
      const tdhKey: MembershipSourceKey = {
        ...profileKey,
        dimension: 'TDH_XTDH'
      };
      const tdhJob = { job_id: 'tdh-cycle', keys: [tdhKey] };
      await provision(withGlobalSourceKeys([tdhKey]));
      let current = await tx((ctx) =>
        jobs().start(tdhJob, { stage: 'TDH_PERSISTED', after_id: null }, ctx)
      );
      for (const stage of [
        'TDH_PERSISTED',
        'UNIVERSE_COMMITTED',
        'STATS_ENQUEUED'
      ]) {
        if (current.progress.stage !== stage) {
          current = (
            await tx((ctx) =>
              jobs().checkpoint(
                tdhJob,
                current.progress,
                { stage, after_id: null },
                async () => undefined,
                ctx
              )
            )
          ).state;
        }
        await expect(
          tx((ctx) =>
            jobs().complete(tdhJob, current.progress, [request], writeRep, ctx)
          )
        ).rejects.toThrow('statistics activation');
      }
      expect(await readRep()).toEqual({ rep: 1 });
      expect(await getTarget()).toBeNull();
      current = (
        await tx((ctx) =>
          jobs().checkpoint(
            tdhJob,
            current.progress,
            { stage: 'STATS_ACTIVATED', after_id: null },
            writeRep,
            ctx
          )
        )
      ).state;
      await tx((ctx) =>
        jobs().complete(
          tdhJob,
          current.progress,
          [request],
          async () => undefined,
          ctx
        )
      );
      expect(await readRep()).toEqual({ rep: 2 });
      expect(
        (
          await tx((ctx) =>
            sources().read(withGlobalSourceKeys([tdhKey]), false, ctx)
          )
        ).map((row) => [row.state?.version, row.state?.active_jobs])
      ).toEqual([
        ['2', 0],
        ['2', 0]
      ]);
      expect((await getTarget())?.requested_version).toBe('1');
    });
  }
);
