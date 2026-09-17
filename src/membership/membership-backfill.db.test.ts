import {
  IDENTITIES_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  MEMBERSHIP_BOOTSTRAP_WRITERS,
  MembershipBootstrapDb,
  MembershipTrackedWriterReceipt,
  provisionBornProfiles
} from './membership-bootstrap.db';
import { MembershipBackfillDb } from './membership-backfill.db';
import { MEMBERSHIP_BACKFILL_CHECKPOINT_ID } from './membership-backfill.types';
import { MembershipGcDb } from './membership-gc.db';
import { PrimaryMembershipProfileEvaluator } from './membership-profile-evaluator';
import { withMembershipPrimaryTransaction } from './membership-primary';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import { MembershipRefreshWorker } from './membership-worker';
import { membershipTestOptions } from './membership-worker-test.helpers';

const profiles = [
  'aaaaaaaa-aaaa-4aaa-8aaa-000000000081',
  'aaaaaaaa-aaaa-4aaa-8aaa-000000000082'
];
const identities = profiles.map((profile_id, index) => {
  const address = `0x${String(index + 81).padStart(40, '0')}`;
  return anIdentity(
    {},
    {
      profile_id,
      consolidation_key: address,
      primary_address: address,
      handle: `backfill-${index}`
    }
  );
});
const tx = <T>(
  operation: Parameters<typeof withMembershipPrimaryTransaction<T>>[1]
) => withMembershipPrimaryTransaction(sqlExecutor, operation);
const bootstrap = () => new MembershipBootstrapDb(() => sqlExecutor);
const backfill = () => new MembershipBackfillDb(() => sqlExecutor);
const worker = () =>
  new MembershipRefreshWorker(
    sqlExecutor,
    new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
  );
const gc = () => new MembershipGcDb(() => sqlExecutor);
const gcOptions = {
  reader_grace_millis: 1000,
  scan_age_millis: 0,
  member_batch: 2,
  pending_claim_millis: 10000,
  max_attempts: 2
};

function writerReceipt(): MembershipTrackedWriterReceipt {
  return {
    expected_staging_sha: 'a'.repeat(40),
    verified_at_millis: '1',
    old_invocations_drained_at_millis: '62000',
    units: Object.fromEntries(
      MEMBERSHIP_BOOTSTRAP_WRITERS.map((unit) => [
        unit,
        {
          source_sha: 'a'.repeat(40),
          function_version: '1',
          code_sha256: `${'a'.repeat(43)}=`,
          last_modified_millis: '1',
          timeout_seconds: 1,
          deploy_run_id: '1',
          mode: 'tracking-v1',
          stage: 'staging'
        }
      ])
    ) as MembershipTrackedWriterReceipt['units']
  };
}

async function readyBootstrap() {
  await tx((ctx) => bootstrap().prepare(ctx));
  await sqlExecutor.execute(
    `UPDATE ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}
     SET progress=JSON_SET(progress,
       '$.prepared_at_millis','0',
       '$.pretrack_not_before_millis','960000')
     WHERE id='membership-bootstrap-v1'`
  );
  for (let i = 0; i < 20; i++) {
    const progress = await tx((ctx) => bootstrap().advance(2, ctx));
    if (progress.stage === 'WAITING_FOR_WRITERS') break;
  }
  await tx((ctx) => bootstrap().recordTrackedWriters(writerReceipt(), ctx));
  for (let i = 0; i < 20; i++) {
    const progress = await tx((ctx) => bootstrap().advance(2, ctx));
    if (progress.stage === 'COMPLETE') return;
  }
  throw new Error('Test bootstrap did not complete');
}

async function finishTarget(scope: 'FULL' | 'PROFILE', target_id: string) {
  for (let i = 0; i < 12; i++) {
    const result = await worker().runTarget(
      { scope, target_id },
      membershipTestOptions({ page_size: 1 })
    );
    if (result.outcome === 'COMPLETED') return result;
    if (result.outcome !== 'PENDING')
      throw new Error(`Unexpected ${scope} outcome ${result.outcome}`);
  }
  throw new Error(`${scope} did not complete within twelve quantums`);
}

async function observeUntilConverged() {
  for (let pass = 0; pass < 5; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await tx((ctx) => backfill().observe(1, ctx));
    const observed = await tx((ctx) => backfill().observe(1, ctx));
    if (observed.child_publications_converged) return observed;
  }
  throw new Error('Backfill did not converge');
}

describeWithSeed(
  'membership backfill durable control and publication audit',
  withIdentities(identities),
  () => {
    it('requires completed bootstrap and requests FULL exactly once across restart', async () => {
      await expect(tx((ctx) => backfill().start(ctx))).rejects.toThrow(
        /Membership bootstrap is not (prepared|complete)/
      );
      await readyBootstrap();
      const first = await tx((ctx) => backfill().start(ctx));
      const repeated = await tx((ctx) => backfill().start(ctx));
      expect(repeated.progress.generation_id).toBe(
        first.progress.generation_id
      );
      expect(repeated.progress.full_requested_version).toBe('1');
      const target = await sqlExecutor.oneOrNull<{
        requested_version: string;
      }>(
        `SELECT CAST(requested_version AS CHAR) requested_version
         FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE}
         WHERE scope='FULL' AND target_id='*'`
      );
      expect(target?.requested_version).toBe('1');
      const control = await sqlExecutor.oneOrNull<{ id: string }>(
        `SELECT id FROM ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE} WHERE id=:id`,
        { id: MEMBERSHIP_BACKFILL_CHECKPOINT_ID }
      );
      expect(control?.id).toBe(MEMBERSHIP_BACKFILL_CHECKPOINT_ID);
    });

    it('keeps parent fanout separate from child publications and resumes a partial scan', async () => {
      await readyBootstrap();
      const started = await tx((ctx) => backfill().start(ctx));
      expect(started.parent_fanout_complete).toBe(false);
      const full = await finishTarget('FULL', '*');
      const hint = {
        run_id: full.run_id!,
        target: { scope: 'FULL' as const, target_id: '*' },
        pending: null
      };
      expect(
        (await tx((ctx) => gc().collect(hint, gcOptions, ctx))).outcome
      ).toBe('PROTECTED');
      const first = await tx((ctx) => backfill().observe(1, ctx));
      expect(first.parent_fanout_complete).toBe(true);
      expect(first.child_scan_complete).toBe(false);
      expect(first.progress.scanned_count).toBe('1');
      const paused = await tx((ctx) => backfill().pause(ctx));
      expect(paused.progress.state).toBe('PAUSED');
      const ignored = await tx((ctx) => backfill().observe(1, ctx));
      expect(ignored.progress.scanned_count).toBe('1');
      await tx((ctx) => backfill().resume(ctx));
      const second = await tx((ctx) => backfill().observe(1, ctx));
      expect(second.child_scan_complete).toBe(true);
      expect(second.child_publications_converged).toBe(false);
      expect(second.progress.pending_count).toBe('2');
      for (const profile of profiles) await finishTarget('PROFILE', profile);
      const complete = await observeUntilConverged();
      expect(complete.progress.parent_processed_count).toBe('2');
      expect(complete.progress.published_count).toBe('2');
      expect(complete.progress.pending_count).toBe('0');
      expect(complete.progress.generation_id).toBe(
        started.progress.generation_id
      );
      expect(
        (await tx((ctx) => gc().collect(hint, gcOptions, ctx))).outcome
      ).toBe('RETIRED');
    });

    it('rejects a clean pass when a tracked child changes behind its cursor', async () => {
      await readyBootstrap();
      await tx((ctx) => backfill().start(ctx));
      await finishTarget('FULL', '*');
      for (const profile of profiles) await finishTarget('PROFILE', profile);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const first = await tx((ctx) => backfill().observe(1, ctx));
      expect(first.progress.published_count).toBe('1');
      await tx((ctx) =>
        new MembershipRefreshTargetsDb(() => sqlExecutor).request(
          [
            {
              scope: 'PROFILE',
              target_id: profiles[0],
              reason: 'backfill-race-test'
            }
          ],
          ctx
        )
      );
      const afterRace = await tx((ctx) => backfill().observe(1, ctx));
      expect(afterRace.child_scan_complete).toBe(true);
      expect(afterRace.progress.published_count).toBe('2');
      expect(afterRace.progress.scan_pass_stable).toBe(false);
      expect(afterRace.child_publications_converged).toBe(false);
      await finishTarget('PROFILE', profiles[0]);
      expect((await observeUntilConverged()).child_publications_converged).toBe(
        true
      );
    });

    it('does not converge on a pre-scan global source change', async () => {
      await readyBootstrap();
      await tx((ctx) => backfill().start(ctx));
      await finishTarget('FULL', '*');
      for (const profile of profiles) await finishTarget('PROFILE', profile);
      await tx((ctx) =>
        new MembershipSourceStatesDb(() => sqlExecutor).mutate(
          {
            keys: [{ scope: 'GLOBAL', target_id: '*', dimension: 'RATINGS' }],
            requests: [
              { scope: 'FULL', target_id: '*', reason: 'backfill-global-race' }
            ]
          },
          async () => undefined,
          ctx
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
      await tx((ctx) => backfill().observe(1, ctx));
      const stale = await tx((ctx) => backfill().observe(1, ctx));
      expect(stale.progress.parked_count).toBe('2');
      expect(stale.progress.scan_pass_stable).toBe(false);
      expect(stale.child_publications_converged).toBe(false);
    });

    it('uses a current-read fence when a source commits after page classification', async () => {
      await readyBootstrap();
      await tx((ctx) => backfill().start(ctx));
      await finishTarget('FULL', '*');
      for (const profile of profiles) await finishTarget('PROFILE', profile);
      await tx((ctx) => backfill().observe(1, ctx));
      const original = sqlExecutor.execute.bind(sqlExecutor);
      const execute = jest.spyOn(sqlExecutor, 'execute');
      let inserted = false;
      execute.mockImplementation(async (sql, params, options) => {
        if (
          !inserted &&
          sql.includes('membership_source_states') &&
          sql.includes('FOR UPDATE') &&
          params?.scope === 'GLOBAL' &&
          params?.dimension === 'RATINGS'
        ) {
          inserted = true;
          await tx((ctx) =>
            new MembershipSourceStatesDb(() => sqlExecutor).mutate(
              {
                keys: [
                  { scope: 'GLOBAL', target_id: '*', dimension: 'RATINGS' }
                ],
                requests: [
                  { scope: 'FULL', target_id: '*', reason: 'final-read-race' }
                ]
              },
              async () => undefined,
              ctx
            )
          );
        }
        return original(sql, params, options);
      });
      try {
        const observed = await tx((ctx) => backfill().observe(1, ctx));
        expect(inserted).toBe(true);
        expect(observed.progress.published_count).toBe('2');
        expect(observed.progress.scan_pass_stable).toBe(false);
        expect(observed.child_publications_converged).toBe(false);
      } finally {
        execute.mockRestore();
      }
    });

    it('does not converge while a separate GROUP fanout remains pending', async () => {
      await readyBootstrap();
      await tx((ctx) => backfill().start(ctx));
      await finishTarget('FULL', '*');
      for (const profile of profiles) await finishTarget('PROFILE', profile);
      await tx((ctx) =>
        new MembershipRefreshTargetsDb(() => sqlExecutor).request(
          [{ scope: 'GROUP', target_id: 'backfill-group', reason: 'fanout' }],
          ctx
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 2));
      await tx((ctx) => backfill().observe(1, ctx));
      const observed = await tx((ctx) => backfill().observe(1, ctx));
      expect(observed.progress.pending_count).toBe('0');
      expect(observed.progress.scan_pass_stable).toBe(false);
      expect(observed.child_publications_converged).toBe(false);
    });

    it('rejects a pass if an earlier publication horizon expires', async () => {
      await readyBootstrap();
      await tx((ctx) => backfill().start(ctx));
      await finishTarget('FULL', '*');
      for (const profile of profiles) await finishTarget('PROFILE', profile);
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE} r
         JOIN membership_publications p ON p.run_id=r.id
         SET r.valid_until_millis=CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED)+500
         WHERE p.profile_id=:profile`,
        { profile: profiles[0] }
      );
      const first = await tx((ctx) => backfill().observe(1, ctx));
      expect(first.progress.minimum_horizon_millis).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 650));
      const observed = await tx((ctx) => backfill().observe(1, ctx));
      expect(observed.progress.pending_count).toBe('0');
      expect(observed.progress.scan_pass_stable).toBe(false);
      expect(observed.child_publications_converged).toBe(false);
    });

    it('converges after a tracked birth changes the current cohort count', async () => {
      await readyBootstrap();
      await tx((ctx) => backfill().start(ctx));
      await finishTarget('FULL', '*');
      for (const profile of profiles) await finishTarget('PROFILE', profile);
      const born = anIdentity(
        {},
        {
          profile_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000080',
          consolidation_key: '0x0000000000000000000000000000000000000080',
          primary_address: '0x0000000000000000000000000000000000000080',
          handle: 'born-behind-backfill'
        }
      );
      await tx(async (ctx) => {
        await sqlExecutor.bulkInsert(
          IDENTITIES_TABLE,
          [born],
          Object.keys(born),
          ctx
        );
        await provisionBornProfiles([born.profile_id!], ctx);
      });
      await finishTarget('PROFILE', born.profile_id!);
      const complete = await observeUntilConverged();
      expect(complete.progress.parent_processed_count).toBe('2');
      expect(complete.progress.scanned_count).toBe('3');
      expect(complete.child_publications_converged).toBe(true);
    });

    it('retains only one FULL parent while repeated later FULL runs remain collectable', async () => {
      await readyBootstrap();
      await tx((ctx) => backfill().start(ctx));
      const first = await finishTarget('FULL', '*');
      await tx((ctx) =>
        new MembershipRefreshTargetsDb(() => sqlExecutor).request(
          [{ scope: 'FULL', target_id: '*', reason: 'later-full' }],
          ctx
        )
      );
      const second = await finishTarget('FULL', '*');
      const hint = (run_id: string) => ({
        run_id,
        target: { scope: 'FULL' as const, target_id: '*' },
        pending: null
      });
      expect(
        (await tx((ctx) => gc().collect(hint(first.run_id!), gcOptions, ctx)))
          .outcome
      ).toBe('RETIRED');
      expect(
        (await tx((ctx) => gc().collect(hint(second.run_id!), gcOptions, ctx)))
          .outcome
      ).toBe('PROTECTED');
      const observed = await tx((ctx) => backfill().observe(1, ctx));
      expect(observed.progress.parent_run_id).toBe(second.run_id);
      await tx((ctx) =>
        new MembershipRefreshTargetsDb(() => sqlExecutor).request(
          [{ scope: 'FULL', target_id: '*', reason: 'third-full' }],
          ctx
        )
      );
      const third = await finishTarget('FULL', '*');
      expect(
        (await tx((ctx) => gc().collect(hint(second.run_id!), gcOptions, ctx)))
          .outcome
      ).toBe('PROTECTED');
      expect(
        (await tx((ctx) => gc().collect(hint(third.run_id!), gcOptions, ctx)))
          .outcome
      ).toBe('RETIRED');
    });
  }
);
