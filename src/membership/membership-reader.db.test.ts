import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  MEMBERSHIP_PUBLICATIONS_TABLE,
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE,
  IDENTITIES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { MembershipReader } from './membership-reader';
import {
  membershipProfileSourceKeys,
  PrimaryMembershipProfileEvaluator
} from './membership-profile-evaluator';
import { MembershipSourceStatesDb } from './membership-source-states.db';
import {
  membershipQueryOptions,
  withMembershipPrimaryTransaction
} from './membership-primary';
import {
  UserGroupsService,
  userGroupsService
} from '@/api/community-members/user-groups.service';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { performance } from 'node:perf_hooks';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { MembershipRefreshTargetsDb } from './membership-refresh-targets.db';
import { MembershipRefreshWorker } from './membership-worker';
import { membershipTestOptions } from './membership-worker-test.helpers';
import {
  membershipCatalogueMutation,
  membershipGlobalMutation,
  withMembershipSourceMutation
} from './membership-producer-writes';
import * as producerPolicy from './membership-producer-policy';
import * as readerPolicy from './membership-reader-policy';

const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000097';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000097';
const wallet = '0x0000000000000000000000000000000000000097';
const identity = anIdentity(
  { rep: 20 },
  {
    profile_id: profileId,
    consolidation_key: wallet,
    primary_address: wallet,
    handle: 'reader-fixture'
  }
);
const list = aUserGroup(
  { profile_group_id: 'reader-list' },
  { id: 'a-list', name: 'a-list' }
);
const rep = aUserGroup({ rep_min: 10 }, { id: 'b-rep', name: 'b-rep' });
const newlyJoined = aUserGroup(
  { profile_group_id: 'reader-list' },
  { id: 'c-new', name: 'c-new' }
);

async function provision() {
  await withMembershipPrimaryTransaction(sqlExecutor, (ctx) =>
    new MembershipSourceStatesDb(() => sqlExecutor).provision(
      membershipProfileSourceKeys(profileId),
      { bootstrap_id: 'reader-test', coverage_revision: 'isolated-fixture' },
      ctx
    )
  );
}
async function publish(memberIds: string[]) {
  const now = Date.now() - 1000;
  await sqlExecutor.execute(
    `INSERT INTO ${MEMBERSHIP_REFRESH_RUNS_TABLE}
      (id,scope,target_id,request_version,status,spec_version,catalog_version,source_versions,
       progress_cursor,evaluation_time_millis,valid_until_millis,lease_token,lease_expires_at_millis,
       checkpoint_version,processed_count,created_at_millis,updated_at_millis,completed_at_millis)
     VALUES (:run,'PROFILE',:profile,1,'COMPLETED',2,0,:vector,:cursor,:now,NULL,NULL,NULL,1,3,:now,:now,:now)`,
    {
      run: runId,
      profile: profileId,
      now,
      vector: JSON.stringify(
        membershipProfileSourceKeys(profileId).map((key) => ({
          ...key,
          version: '0'
        }))
      ),
      cursor: JSON.stringify({
        protocol_version: 2,
        kind: 'PROFILE',
        phase: 'DONE',
        after_id: 'z',
        through_id: 'z',
        traversal_collation: 'utf8mb4_unicode_ci',
        identity_consolidation_key: wallet,
        active_input: null
      })
    }
  );
  await sqlExecutor.execute(
    `INSERT INTO ${MEMBERSHIP_PUBLICATIONS_TABLE} (profile_id,run_id,published_at_millis)
     VALUES (:profile,:run,:now)`,
    { profile: profileId, run: runId, now }
  );
  for (const group of memberIds)
    await sqlExecutor.execute(
      `INSERT INTO ${MEMBERSHIP_GENERATION_MEMBERS_TABLE} (run_id,group_id,profile_id)
       VALUES (:run,:group,:profile)`,
      { run: runId, group, profile: profileId }
    );
}
const read = (shadow = false) =>
  new MembershipReader(() => sqlExecutor, 'isolated-fixture').read(
    profileId,
    async () => [list.id, rep.id, newlyJoined.id],
    (profile, ids, ctx) =>
      userGroupsService.evaluateGroupsOnPrimary(profile, ids, ctx),
    shadow
  );

async function publishWithWorker() {
  const target = { scope: 'PROFILE' as const, target_id: profileId };
  await withMembershipPrimaryTransaction(sqlExecutor, (ctx) =>
    new MembershipRefreshTargetsDb(() => sqlExecutor).request(
      [{ ...target, reason: 'reader-sustained-change' }],
      ctx
    )
  );
  const worker = new MembershipRefreshWorker(
    sqlExecutor,
    new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
  );
  for (let invocation = 0; invocation < 30; invocation++) {
    const result = await worker.runTarget(target, membershipTestOptions());
    if (result.outcome === 'COMPLETED') return;
    expect(result.outcome).toBe('PENDING');
  }
  throw new Error('Real evaluator and worker did not complete the profile');
}

async function trackedRepChange(value: number) {
  const active = jest
    .spyOn(producerPolicy, 'isMembershipSourceTrackingActive')
    .mockReturnValue(true);
  try {
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      withMembershipSourceMutation(
        connection,
        membershipGlobalMutation(['RATINGS'], 'reader-sustained-change'),
        () =>
          sqlExecutor
            .execute(
              `UPDATE ${IDENTITIES_TABLE} SET rep=:rep WHERE profile_id=:profile`,
              { rep: value, profile: profileId },
              { wrappedConnection: connection }
            )
            .then(() => undefined),
        { connection }
      )
    );
  } finally {
    active.mockRestore();
  }
}

async function controlledApiRead() {
  const controlled = jest
    .spyOn(readerPolicy, 'membershipReaderPolicy')
    .mockReturnValue({ read: true, shadow: true });
  try {
    const service = new UserGroupsService(
      new UserGroupsDb(() => sqlExecutor),
      {} as never,
      {} as never,
      undefined,
      new MembershipReader(() => sqlExecutor, 'isolated-fixture')
    );
    return service.getGroupsUserIsEligibleFor(profileId);
  } finally {
    controlled.mockRestore();
  }
}

describeWithSeed(
  'scoped membership reader on primary MySQL',
  [
    withIdentities([identity]),
    withUserGroups([list, rep, newlyJoined]),
    {
      table: PROFILE_GROUPS_TABLE,
      rows: [{ profile_group_id: 'reader-list', profile_id: profileId }]
    },
    {
      table: WAVES_TABLE,
      rows: [list, rep, newlyJoined].map((group) => {
        const { serial_no: _serialNo, ...wave } = aWave(
          { visibility_group_id: group.id },
          { id: `wave-${group.id}`, name: group.id }
        );
        return wave;
      })
    }
  ],
  () => {
    beforeEach(async () => {
      await provision();
      for (const group of [list, rep, newlyJoined])
        await sqlExecutor.execute(
          `INSERT INTO ${MEMBERSHIP_GROUP_VERSIONS_TABLE}
         (group_id,catalog_version,is_deleted,updated_at_millis) VALUES (:id,0,0,1)`,
          { id: group.id }
        );
    });

    it('uses direct evaluation when a publication is missing, never an authoritative empty set', async () => {
      const result = await read(true);
      expect(new Set(result.eligible_group_ids)).toEqual(
        new Set([list.id, rep.id, newlyJoined.id])
      );
      expect(result.materialized_count).toBe(0);
      expect(result.fallback_reasons.publication_missing).toBe(3);
      expect(result.shadow_equal).toBe(true);
    });

    it('accepts completed-empty publication and reports full clean coverage', async () => {
      await publish([]);
      const result = await read(true);
      expect(result.eligible_group_ids).toEqual([]);
      expect(result.materialized_count).toBe(3);
      expect(result.direct_count).toBe(0);
      // The controlled comparison detects an inconsistent synthetic publication.
      expect(result.shadow_equal).toBe(false);
    });

    it('requires the audited coverage revision before reusing a publication', async () => {
      await publish([list.id, rep.id, newlyJoined.id]);
      const result = await new MembershipReader(() => sqlExecutor, null).read(
        profileId,
        async () => [list.id, rep.id, newlyJoined.id],
        (profile, ids, ctx) =>
          userGroupsService.evaluateGroupsOnPrimary(profile, ids, ctx)
      );
      expect(result.materialized_count).toBe(0);
      expect(result.direct_count).toBe(3);
      expect(result.fallback_reasons.catalogue_unready).toBe(3);
    });

    it('rejects a different bootstrap revision and an invalid completed cursor', async () => {
      await publish([list.id, rep.id, newlyJoined.id]);
      const wrongRevision = await new MembershipReader(
        () => sqlExecutor,
        'not-the-audited-revision'
      ).read(
        profileId,
        async () => [list.id, rep.id, newlyJoined.id],
        (profile, ids, ctx) =>
          userGroupsService.evaluateGroupsOnPrimary(profile, ids, ctx)
      );
      expect(wrongRevision.materialized_count).toBe(0);
      expect(wrongRevision.direct_count).toBe(3);
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_REFRESH_RUNS_TABLE}
         SET progress_cursor=JSON_SET(progress_cursor,'$.traversal_collation','utf8mb4_bin')
         WHERE id=:run`,
        { run: runId }
      );
      const invalidCursor = await read();
      expect(invalidCursor.materialized_count).toBe(0);
      expect(invalidCursor.fallback_reasons.publication_invalid).toBe(3);
    });

    it('directly reevaluates only dirty groups, including a newly joined group', async () => {
      await publish([list.id, rep.id]);
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_GROUP_VERSIONS_TABLE} SET catalog_version=1 WHERE group_id=:id`,
        { id: newlyJoined.id }
      );
      await sqlExecutor.execute(
        `UPDATE ${IDENTITIES_TABLE} SET rep=0 WHERE profile_id=:profile`,
        { profile: profileId }
      );
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version=1
       WHERE scope='PROFILE' AND target_id=:profile AND dimension='RATINGS'`,
        { profile: profileId }
      );
      const result = await read(true);
      expect(new Set(result.eligible_group_ids)).toEqual(
        new Set([list.id, newlyJoined.id])
      );
      expect(result.materialized_count).toBe(1);
      expect(result.direct_count).toBe(2);
      expect(result.fallback_reasons.source_changed).toBe(1);
      expect(result.fallback_reasons.group_changed).toBe(1);
      expect(result.shadow_equal).toBe(true);
    });

    it('keeps missing source receipts and active jobs unknown for their dependent groups', async () => {
      await publish([list.id, rep.id, newlyJoined.id]);
      await sqlExecutor.execute(
        `DELETE FROM membership_source_jobs WHERE scope='PROFILE' AND target_id=:profile
       AND dimension='RATINGS' AND job_id LIKE 'bootstrap:%'`,
        { profile: profileId }
      );
      let result = await read();
      expect(result.materialized_count).toBe(2);
      expect(result.fallback_reasons.source_unready).toBe(1);
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET active_jobs=1
       WHERE scope='PROFILE' AND target_id=:profile AND dimension='RATINGS'`,
        { profile: profileId }
      );
      result = await read();
      expect(result.materialized_count).toBe(2);
      expect(result.fallback_reasons.source_unready).toBe(1);
    });

    it('excludes an invisible group under current direct candidate semantics', async () => {
      await publish([list.id, rep.id, newlyJoined.id]);
      await sqlExecutor.execute(
        `UPDATE ${USER_GROUPS_TABLE} SET visible=0 WHERE id=:id`,
        { id: list.id }
      );
      const result = await read(true);
      expect(result.candidate_count).toBe(2);
      expect(result.eligible_group_ids).not.toContain(list.id);
      expect(result.shadow_equal).toBe(true);
    });

    it('refuses an incomplete direct candidate set without treating it as empty', async () => {
      const reader = new MembershipReader(
        () => sqlExecutor,
        'isolated-fixture'
      );
      const direct = jest.fn();
      await expect(
        reader.readDirect(
          profileId,
          async () => Array.from({ length: 1025 }, (_v, i) => `group-${i}`),
          direct,
          performance.now() + 12_000
        )
      ).rejects.toThrow('Membership direct candidate bound exceeded');
      expect(direct).not.toHaveBeenCalled();
    });

    it('uses the transaction-bound primary inputs for direct fallback', async () => {
      await withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
        await sqlExecutor.execute(
          `UPDATE ${IDENTITIES_TABLE} SET rep=0 WHERE profile_id=:profile`,
          { profile: profileId },
          { wrappedConnection: ctx.connection }
        );
        expect(
          await userGroupsService.evaluateGroupsOnPrimary(
            profileId,
            [rep.id],
            ctx
          )
        ).toEqual([]);
        throw new Error('rollback fixture');
      }).catch((error: Error) =>
        expect(error.message).toBe('rollback fixture')
      );
      const result = await read();
      expect(result.eligible_group_ids).toContain(rep.id);
    });

    it('keeps clean groups materialized across a concurrent tracked change and repeated source churn, then recovers with a real worker publication', async () => {
      await publishWithWorker();
      const baseline = await read(true);
      expect(baseline.materialized_count).toBe(3);
      expect(baseline.direct_count).toBe(0);
      expect(baseline.shadow_equal).toBe(true);
      expect(new Set(await controlledApiRead())).toEqual(
        new Set([list.id, rep.id, newlyJoined.id])
      );

      let captured!: () => void;
      let release!: () => void;
      const snapshotCaptured = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const continueRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const overlapping = new MembershipReader(
        () => sqlExecutor,
        'isolated-fixture'
      ).read(
        profileId,
        async (ctx) => {
          await sqlExecutor.oneOrNull(
            `SELECT rep FROM ${IDENTITIES_TABLE} WHERE profile_id=:profile`,
            { profile: profileId },
            membershipQueryOptions(ctx)
          );
          captured();
          await continueRead;
          return [list.id, rep.id, newlyJoined.id];
        },
        (profile, ids, ctx) =>
          userGroupsService.evaluateGroupsOnPrimary(profile, ids, ctx),
        true
      );
      await snapshotCaptured;
      try {
        await trackedRepChange(0);
      } finally {
        release();
      }
      const beforeCommit = await overlapping;
      expect(beforeCommit.materialized_count).toBe(3);
      expect(beforeCommit.direct_count).toBe(0);
      expect(beforeCommit.shadow_equal).toBe(true);
      expect(new Set(await controlledApiRead())).toEqual(
        new Set([list.id, newlyJoined.id])
      );

      for (let change = 0; change < 8; change++) {
        const value = change % 2 === 0 ? 20 : 0;
        await trackedRepChange(value);
        const result = await read(true);
        expect(result.materialized_count).toBe(2);
        expect(result.direct_count).toBe(1);
        expect(result.fallback_reasons).toEqual({ source_changed: 1 });
        expect(result.eligible_group_ids).toContain(list.id);
        expect(result.eligible_group_ids).toContain(newlyJoined.id);
        expect(result.eligible_group_ids.includes(rep.id)).toBe(value >= 10);
        expect(result.direct_duration_ms).toBeGreaterThanOrEqual(0);
        expect(result.shadow_equal).toBe(true);
      }

      await publishWithWorker();
      const recovered = await read(true);
      expect(recovered.materialized_count).toBe(3);
      expect(recovered.direct_count).toBe(0);
      expect(recovered.fallback_reasons).toEqual({});
      expect(recovered.shadow_equal).toBe(true);
      expect(new Set(await controlledApiRead())).toEqual(
        new Set([list.id, newlyJoined.id])
      );
    }, 120000);

    it('keeps clean groups readable while a failed group refresh is parked and a routine full refresh runs', async () => {
      await publishWithWorker();
      const group = { scope: 'GROUP' as const, target_id: rep.id };
      const tracking = jest
        .spyOn(producerPolicy, 'isMembershipSourceTrackingActive')
        .mockReturnValue(true);
      try {
        await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          withMembershipSourceMutation(
            connection,
            membershipCatalogueMutation(
              [{ group_id: rep.id, is_deleted: false }],
              'reader-failed-group'
            ),
            () =>
              sqlExecutor
                .execute(
                  `UPDATE ${USER_GROUPS_TABLE} SET rep_min=15 WHERE id=:group`,
                  { group: rep.id },
                  { wrappedConnection: connection }
                )
                .then(() => undefined),
            { connection }
          )
        );
      } finally {
        tracking.mockRestore();
      }
      await sqlExecutor.execute(
        `UPDATE ${MEMBERSHIP_REFRESH_TARGETS_TABLE}
         SET attempts=3,last_error='injected worker failure',
             available_at_millis=9223372036854775807
         WHERE scope='GROUP' AND target_id=:group`,
        { group: rep.id }
      );
      const parked = await read(true);
      expect(parked.materialized_count).toBe(2);
      expect(parked.direct_count).toBe(1);
      expect(parked.fallback_reasons).toEqual({ group_changed: 1 });
      expect(parked.shadow_equal).toBe(true);
      expect(new Set(await controlledApiRead())).toEqual(
        new Set([list.id, rep.id, newlyJoined.id])
      );

      const full = { scope: 'FULL' as const, target_id: '*' };
      await withMembershipPrimaryTransaction(sqlExecutor, (ctx) =>
        new MembershipRefreshTargetsDb(() => sqlExecutor).request(
          [{ ...full, reason: 'routine-full-refresh' }],
          ctx
        )
      );
      const worker = new MembershipRefreshWorker(
        sqlExecutor,
        new PrimaryMembershipProfileEvaluator(() => sqlExecutor)
      );
      expect(
        (await worker.runTarget(full, membershipTestOptions())).outcome
      ).toBe('PENDING');
      const duringFull = await read(true);
      expect(duringFull.materialized_count).toBe(2);
      expect(duringFull.fallback_reasons).toEqual({ group_changed: 1 });
      expect(duringFull.shadow_equal).toBe(true);

      await withMembershipPrimaryTransaction(sqlExecutor, (ctx) =>
        new MembershipRefreshTargetsDb(() => sqlExecutor).request(
          [{ ...group, reason: 'reader-retry-group' }],
          ctx
        )
      );
      for (const target of [group, full]) {
        let completed = false;
        for (let invocation = 0; invocation < 30; invocation++) {
          const result = await worker.runTarget(
            target,
            membershipTestOptions()
          );
          if (result.outcome === 'COMPLETED') {
            completed = true;
            break;
          }
          expect(result.outcome).toBe('PENDING');
        }
        expect(completed).toBe(true);
      }
      await publishWithWorker();
      const recovered = await read(true);
      expect(recovered.materialized_count).toBe(3);
      expect(recovered.direct_count).toBe(0);
      expect(recovered.shadow_equal).toBe(true);
    }, 120000);
  }
);
