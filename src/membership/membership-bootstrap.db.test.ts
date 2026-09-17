import {
  IDENTITIES_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE,
  MEMBERSHIP_SOURCE_JOBS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { identitiesDb } from '@/identities/identities.db';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import {
  MembershipPrimaryContext,
  membershipQueryOptions,
  withMembershipPrimaryTransaction
} from './membership-primary';
import {
  MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION,
  MEMBERSHIP_BOOTSTRAP_WRITERS,
  MembershipBootstrapDb,
  MembershipTrackedWriterReceipt,
  provisionBornProfiles,
  requireMembershipBootstrapReady
} from './membership-bootstrap.db';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import {
  membershipCatalogueMutation,
  membershipGlobalMutation
} from './membership-producer-writes';

const p1 = anIdentity(
  {},
  {
    consolidation_key: '0x0000000000000000000000000000000000000001',
    primary_address: '0x0000000000000000000000000000000000000001',
    profile_id: 'a-profile',
    handle: 'a-profile'
  }
);
const p2 = anIdentity(
  {},
  {
    consolidation_key: '0x0000000000000000000000000000000000000002',
    primary_address: '0x0000000000000000000000000000000000000002',
    profile_id: 'z-profile',
    handle: 'z-profile'
  }
);
const g1 = aUserGroup({}, { id: 'a-group', name: 'A group' });
const g2 = aUserGroup({}, { id: 'z-group', name: 'Z group' });
const tx = <T>(callback: (ctx: MembershipPrimaryContext) => Promise<T>) =>
  withMembershipPrimaryTransaction(sqlExecutor, callback);
const bootstrap = () => new MembershipBootstrapDb(() => sqlExecutor);

function writerReceipt(): MembershipTrackedWriterReceipt {
  return {
    expected_staging_sha: 'a'.repeat(40),
    verified_at_millis: '1000',
    old_invocations_drained_at_millis: '100000',
    units: Object.fromEntries(
      MEMBERSHIP_BOOTSTRAP_WRITERS.map((unit) => [
        unit,
        {
          source_sha: 'a'.repeat(40),
          function_version: '1',
          // AWS Base64 hashes may contain letters outside hexadecimal.
          code_sha256: `${'zG'.repeat(21)}z=`,
          last_modified_millis: '0',
          timeout_seconds: 1,
          deploy_run_id: '1',
          mode: 'tracking-v1',
          stage: 'staging'
        }
      ])
    ) as MembershipTrackedWriterReceipt['units']
  };
}

async function passPretrackFenceInTest(): Promise<void> {
  await sqlExecutor.execute(
    `UPDATE ${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}
     SET progress=JSON_SET(progress,
       '$.prepared_at_millis','0',
       '$.pretrack_not_before_millis','960000')
     WHERE id='membership-bootstrap-v1'`
  );
}

async function advanceTo(stage: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const progress = await tx((ctx) => bootstrap().advance(1, ctx));
    if (progress.stage === stage) return;
  }
  throw new Error(`Bootstrap did not reach ${stage}`);
}

describeWithSeed(
  'membership bootstrap source and catalogue baseline',
  [withIdentities([p1, p2]), withUserGroups([g1, g2])],
  () => {
    it('resumes bounded pages, requires writer evidence, and completes one audited baseline', async () => {
      expect((await tx((ctx) => bootstrap().prepare(ctx))).stage).toBe(
        'GLOBAL_READY'
      );
      expect((await tx((ctx) => bootstrap().advance(1, ctx))).stage).toBe(
        'GLOBAL_READY'
      );
      await passPretrackFenceInTest();
      await advanceTo('WAITING_FOR_WRITERS');
      await expect(tx(requireMembershipBootstrapReady)).rejects.toThrow(
        'not complete'
      );
      const invalid = writerReceipt();
      delete (invalid.units as Record<string, unknown>).api;
      await expect(
        tx((ctx) => bootstrap().recordTrackedWriters(invalid, ctx))
      ).rejects.toThrow('incomplete');
      const receipt = writerReceipt();
      expect(
        (await tx((ctx) => bootstrap().recordTrackedWriters(receipt, ctx)))
          .stage
      ).toBe('GROUP_SCAN');
      await expect(
        tx((ctx) =>
          bootstrap().recordTrackedWriters(
            { ...receipt, verified_at_millis: '1001' },
            ctx
          )
        )
      ).rejects.toThrow('immutable');
      await advanceTo('COMPLETE');
      const ready = await tx(requireMembershipBootstrapReady);
      expect(ready.coverage_revision).toBe(
        MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION
      );
      expect(ready.profile.scanned).toBe('4');
      expect(ready.profile.inserted).toBe('12');
      expect(ready.group.inserted).toBe('2');
      expect(ready.baseline_source_versions?.GROUP_CATALOG).toBe('0');
      expect((await tx((ctx) => bootstrap().prepare(ctx))).stage).toBe(
        'COMPLETE'
      );
      expect((await tx((ctx) => bootstrap().advance(1, ctx))).stage).toBe(
        'COMPLETE'
      );
      const sourceCount = await sqlExecutor.oneOrNull<{ count: number }>(
        `SELECT COUNT(*) count FROM ${MEMBERSHIP_SOURCE_STATES_TABLE}`
      );
      const receiptCount = await sqlExecutor.oneOrNull<{ count: number }>(
        `SELECT COUNT(*) count FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
         WHERE status='COMPLETED' AND (job_id LIKE 'bootstrap:%' OR job_id LIKE 'birth:%')`
      );
      const groupCount = await sqlExecutor.oneOrNull<{ count: number }>(
        `SELECT COUNT(*) count FROM ${MEMBERSHIP_GROUP_VERSIONS_TABLE}`
      );
      expect(Number(sourceCount?.count)).toBe(19);
      expect(Number(receiptCount?.count)).toBe(19);
      expect(Number(groupCount?.count)).toBe(2);
    });

    it('provisions a born identity and its request in the creation transaction', async () => {
      await tx((ctx) => bootstrap().prepare(ctx));
      await passPretrackFenceInTest();
      const born = anIdentity(
        {},
        {
          consolidation_key: '0x0000000000000000000000000000000000000003',
          primary_address: '0x0000000000000000000000000000000000000003',
          profile_id: 'born-profile',
          handle: 'born-profile'
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
      const birthReceipts = await sqlExecutor.oneOrNull<{ count: number }>(
        `SELECT COUNT(*) count FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
         WHERE scope='PROFILE' AND target_id=:id AND job_id LIKE 'birth:%'`,
        { id: born.profile_id }
      );
      const request = await sqlExecutor.oneOrNull<{ scope: string }>(
        `SELECT scope FROM ${MEMBERSHIP_REFRESH_TARGETS_TABLE}
         WHERE scope='PROFILE' AND target_id=:id`,
        { id: born.profile_id }
      );
      expect(Number(birthReceipts?.count)).toBe(6);
      expect(request?.scope).toBe('PROFILE');
      await advanceTo('WAITING_FOR_WRITERS');
      expect(
        (await tx((ctx) => bootstrap().status(ctx)))?.profile.inserted
      ).toBe('12');
    });

    it('covers the real group-list identity insertion path', async () => {
      await tx((ctx) => bootstrap().prepare(ctx));
      const address = '0x0000000000000000000000000000000000000004';
      await tx((ctx) =>
        identitiesDb.insertIdentitiesOnAddressesOnly([address], ctx.connection)
      );
      const born = await sqlExecutor.oneOrNull<{ profile_id: string }>(
        `SELECT profile_id FROM ${IDENTITIES_TABLE} WHERE primary_address=:address`,
        { address }
      );
      expect(born?.profile_id).toBeDefined();
      const receipt = await sqlExecutor.oneOrNull<{ count: number }>(
        `SELECT COUNT(*) count FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
         WHERE scope='PROFILE' AND target_id=:id AND job_id LIKE 'birth:%'`,
        { id: born?.profile_id }
      );
      expect(Number(receipt?.count)).toBe(6);
    });

    it('sees prepare from a creator transaction with an older repeatable-read snapshot', async () => {
      let signalOpened: () => void = () => undefined;
      let continueCreator: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => {
        signalOpened = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        continueCreator = resolve;
      });
      const born = anIdentity(
        {},
        {
          consolidation_key: '0x0000000000000000000000000000000000000005',
          primary_address: '0x0000000000000000000000000000000000000005',
          profile_id: 'late-born-profile',
          handle: 'late-born-profile'
        }
      );
      const creator = tx(async (ctx) => {
        await sqlExecutor.oneOrNull(
          `SELECT COUNT(*) count FROM ${IDENTITIES_TABLE}`,
          {},
          membershipQueryOptions(ctx)
        );
        signalOpened();
        await resume;
        await sqlExecutor.bulkInsert(
          IDENTITIES_TABLE,
          [born],
          Object.keys(born),
          ctx
        );
        await provisionBornProfiles([born.profile_id!], ctx);
      });
      await opened;
      try {
        await tx((ctx) => bootstrap().prepare(ctx));
      } finally {
        continueCreator();
      }
      await creator;
      const receipt = await sqlExecutor.oneOrNull<{ count: number }>(
        `SELECT COUNT(*) count FROM ${MEMBERSHIP_SOURCE_JOBS_TABLE}
         WHERE scope='PROFILE' AND target_id=:id AND job_id LIKE 'birth:%'`,
        { id: born.profile_id }
      );
      expect(Number(receipt?.count)).toBe(6);
    });

    it('rejects old GLOBAL receipts without certifying a new coverage revision', async () => {
      await tx((ctx) =>
        new MembershipSourceStatesDb(() => sqlExecutor).provision(
          [{ scope: 'GLOBAL', target_id: '*', dimension: 'IDENTITY' }],
          { bootstrap_id: 'older', coverage_revision: 'older-revision' },
          ctx
        )
      );
      await expect(tx((ctx) => bootstrap().prepare(ctx))).rejects.toThrow(
        'old coverage'
      );
      expect(await tx((ctx) => bootstrap().status(ctx))).toBeNull();
    });

    it('rejects a profile receipt with the current revision but another bootstrap ID', async () => {
      await tx((ctx) =>
        new MembershipSourceStatesDb(() => sqlExecutor).provision(
          [
            {
              scope: 'PROFILE',
              target_id: p1.profile_id!,
              dimension: 'RATINGS'
            }
          ],
          {
            bootstrap_id: 'another-run',
            coverage_revision: MEMBERSHIP_BOOTSTRAP_COVERAGE_REVISION
          },
          ctx
        )
      );
      await tx((ctx) => bootstrap().prepare(ctx));
      await passPretrackFenceInTest();
      await tx((ctx) => bootstrap().advance(1, ctx));
      await expect(tx((ctx) => bootstrap().advance(1, ctx))).rejects.toThrow(
        'invalid provisioning evidence'
      );
    });

    it('rejects an existing source state without a genuine receipt', async () => {
      await tx((ctx) => bootstrap().prepare(ctx));
      await passPretrackFenceInTest();
      await sqlExecutor.execute(
        `INSERT INTO ${MEMBERSHIP_SOURCE_STATES_TABLE}
         (scope,target_id,dimension,version,active_jobs,updated_at_millis)
         VALUES ('PROFILE',:id,'RATINGS',7,0,1)`,
        { id: p1.profile_id }
      );
      await tx((ctx) => bootstrap().advance(1, ctx));
      await expect(tx((ctx) => bootstrap().advance(1, ctx))).rejects.toThrow(
        'no audited receipt'
      );
      expect((await tx((ctx) => bootstrap().status(ctx)))?.stage).toBe(
        'PRETRACK_PROFILE_SCAN'
      );
    });

    it('preserves a tracked group version and restarts after a catalogue change', async () => {
      await tx((ctx) => bootstrap().prepare(ctx));
      await passPretrackFenceInTest();
      await advanceTo('WAITING_FOR_WRITERS');
      await tx((ctx) => bootstrap().recordTrackedWriters(writerReceipt(), ctx));
      await tx((ctx) =>
        new MembershipSourceStatesDb(() => sqlExecutor).mutate(
          membershipCatalogueMutation(
            [{ group_id: g1.id, is_deleted: false }],
            'test-group-change'
          ),
          async () => undefined,
          ctx
        )
      );
      await advanceTo('COMPLETE');
      const version = await sqlExecutor.oneOrNull<{ version: string }>(
        `SELECT CAST(catalog_version AS CHAR) version
         FROM ${MEMBERSHIP_GROUP_VERSIONS_TABLE} WHERE group_id=:id`,
        { id: g1.id }
      );
      expect(version?.version).toBe('1');
      expect((await tx((ctx) => bootstrap().status(ctx)))?.group.sweeps).toBe(
        '2'
      );
    });

    it('does not hold the GLOBAL identity lock while a profile page waits', async () => {
      await tx((ctx) => bootstrap().prepare(ctx));
      await passPretrackFenceInTest();
      await advanceTo('WAITING_FOR_WRITERS');
      await tx((ctx) => bootstrap().recordTrackedWriters(writerReceipt(), ctx));
      await advanceTo('POSTTRACK_PROFILE_SCAN');
      let signalLocked: () => void = () => undefined;
      let releaseBlocker: () => void = () => undefined;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      const blocker = tx(async (ctx) => {
        await sqlExecutor.oneOrNull(
          `SELECT target_id FROM ${MEMBERSHIP_SOURCE_STATES_TABLE}
           WHERE scope='PROFILE' AND target_id=:id AND dimension='RATINGS' FOR UPDATE`,
          { id: p1.profile_id },
          membershipQueryOptions(ctx)
        );
        signalLocked();
        await release;
      });
      await locked;
      const page = tx((ctx) => bootstrap().advance(1, ctx));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const writer = tx((ctx) =>
        new MembershipSourceStatesDb(() => sqlExecutor).mutate(
          membershipGlobalMutation(['IDENTITY'], 'bootstrap-concurrent-birth'),
          async () => undefined,
          ctx
        )
      );
      try {
        const writerCompleted = await Promise.race([
          writer.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 1500)
          )
        ]);
        expect(writerCompleted).toBe(true);
      } finally {
        releaseBlocker();
      }
      await Promise.all([blocker, page, writer]);
      await advanceTo('COMPLETE');
      expect(
        Number((await tx((ctx) => bootstrap().status(ctx)))?.profile.sweeps)
      ).toBeGreaterThan(2);
    });
  }
);
