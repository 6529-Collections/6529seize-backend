import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import {
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { IdentitySubscriptionsDb } from './identity-subscriptions.db';
import { WaveFollowerEligibilityService } from './wave-follower-eligibility';

const identities = ['alice', 'bob', 'carol', 'former'].map((id, index) =>
  anIdentity(
    { tdh: 100 - index * 25, level_raw: 100 },
    {
      profile_id: id,
      handle: id,
      primary_address: `0x${id}`,
      consolidation_key: id
    }
  )
);
const groups = [
  aUserGroup({ tdh_min: 50 }, { id: 'readers', name: 'Readers' }),
  aUserGroup({ tdh_min: 75 }, { id: 'parent-readers', name: 'Parent readers' }),
  aUserGroup(
    { rep_min: 5, rep_category: 'Art' },
    { id: 'rep-readers', name: 'REP readers' }
  ),
  aUserGroup(
    {
      tdh_min: 75,
      profile_group_id: 'included',
      excluded_profile_group_id: 'excluded'
    },
    { id: 'overrides', name: 'Overrides' }
  )
];
const waves = [
  aWave({ visibility_group_id: 'readers' }, { id: 'wave', name: 'Wave' }),
  aWave(
    { visibility_group_id: 'parent-readers' },
    { id: 'parent', name: 'Parent' }
  ),
  aWave(
    { visibility_group_id: 'readers', parent_wave_id: 'parent' },
    { id: 'child', name: 'Child' }
  ),
  aWave(
    {
      chat_group_id: 'missing',
      voting_group_id: 'missing',
      participation_group_id: 'missing'
    },
    { id: 'public', name: 'Public' }
  ),
  aWave({ visibility_group_id: 'rep-readers' }, { id: 'rep', name: 'REP' }),
  aWave(
    { visibility_group_id: 'overrides' },
    { id: 'override', name: 'Override' }
  )
];
const subscriptionRows = waves.flatMap((wave) =>
  identities.map((identity) => ({
    subscriber_id: identity.profile_id,
    target_id: wave.id,
    target_type: ActivityEventTargetType.WAVE,
    target_action: ActivityEventAction.DROP_CREATED
  }))
);

describeWithSeed(
  'Current wave followers',
  [
    withIdentities(identities),
    withUserGroups(groups),
    withWaves(waves),
    { table: IDENTITY_SUBSCRIPTIONS_TABLE, rows: subscriptionRows },
    {
      table: PROFILE_GROUPS_TABLE,
      rows: [
        { profile_group_id: 'included', profile_id: 'former' },
        { profile_group_id: 'excluded', profile_id: 'bob' }
      ]
    },
    withRatings([
      aRepRating({
        rater_profile_id: 'giver',
        matter_target_id: 'alice',
        matter_category: 'Art',
        rating: 10
      })
    ])
  ],
  () => {
    const repo = new IdentitySubscriptionsDb(() => sqlExecutor);
    const eligibility = new WaveFollowerEligibilityService(
      repo,
      userGroupsService
    );

    async function page(waveId: string, pageNumber = 1, pageSize = 100) {
      const params = {
        target_id: waveId,
        target_type: ActivityEventTargetType.WAVE,
        page: pageNumber,
        page_size: pageSize
      };
      const scope = await eligibility.resolve(waveId, {});
      return {
        ids: Object.keys(
          await repo.findSubscriberIdsAndActionsForTarget(params, scope)
        ),
        count: await repo.countDistinctSubscriberIdsForTarget(params, scope)
      };
    }

    it('filters before pagination and counts only current readers', async () => {
      expect(await page('wave', 1, 2)).toEqual({
        ids: ['alice', 'bob'],
        count: 3
      });
      expect(await page('wave', 2, 2)).toEqual({ ids: ['carol'], count: 3 });
    });

    it('hides lost access and restores it without removing subscriptions', async () => {
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set tdh = 0 where profile_id = 'alice'`
      );
      expect((await page('wave')).ids).toEqual(['bob', 'carol']);
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set tdh = 100 where profile_id = 'alice'`
      );
      expect((await page('wave')).ids).toEqual(['alice', 'bob', 'carol']);
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as cnt from ${IDENTITY_SUBSCRIPTIONS_TABLE} where target_id = 'wave'`
        )
      ).toEqual({ cnt: 4 });
    });

    it('intersects child and parent access with independent SQL parameters', async () => {
      expect(await page('child')).toEqual({ ids: ['alice', 'bob'], count: 2 });
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set visibility_group_id = null where id = 'child'`
      );
      expect(await page('child')).toEqual({ ids: ['alice', 'bob'], count: 2 });
    });

    it('deduplicates repeated access groups', async () => {
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set visibility_group_id = 'readers' where id = 'parent'`
      );
      expect(await repo.findWaveFollowerReadGroups('child', {})).toEqual([
        'readers'
      ]);
    });

    it('preserves readers who lose chat, participation or voting access', async () => {
      expect(await page('public')).toEqual({
        ids: ['alice', 'bob', 'carol', 'former'],
        count: 4
      });
    });

    it('keeps explicit inclusions and exclusions consistent with group membership', async () => {
      expect(await page('override')).toEqual({
        ids: ['alice', 'former'],
        count: 2
      });
    });

    it('uses live REP changes instead of cached identity totals', async () => {
      expect(await page('rep')).toEqual({ ids: ['alice'], count: 1 });
      await sqlExecutor.execute(
        `update ${RATINGS_TABLE} set rating = 1 where matter_target_id = 'alice'`
      );
      expect(await page('rep')).toEqual({ ids: [], count: 0 });
    });

    it('returns no readers for missing waves, groups or parent waves', async () => {
      expect(await page('missing')).toEqual({ ids: [], count: 0 });
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set visibility_group_id = 'missing' where id = 'wave'`
      );
      expect(await page('wave')).toEqual({ ids: [], count: 0 });
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set parent_wave_id = 'missing' where id = 'child'`
      );
      expect(await page('child')).toEqual({ ids: [], count: 0 });
    });

    it('does not duplicate readers with multiple subscription actions or identities', async () => {
      await sqlExecutor.execute(
        `insert into ${IDENTITY_SUBSCRIPTIONS_TABLE} (subscriber_id,target_id,target_type,target_action) values ('alice','wave','WAVE','DROP_REPLIED')`
      );
      const duplicate = anIdentity(
        { tdh: 100, level_raw: 100 },
        {
          profile_id: 'alice',
          handle: 'second',
          primary_address: '0xsecond',
          consolidation_key: 'second'
        }
      );
      await sqlExecutor.execute(
        `insert into ${IDENTITIES_TABLE} (consolidation_key,primary_address,profile_id,tdh,cic,rep,level_raw) values (:consolidation_key,:primary_address,:profile_id,:tdh,:cic,:rep,:level_raw)`,
        duplicate
      );
      expect(await page('wave', 1, 2)).toEqual({
        ids: ['alice', 'bob'],
        count: 3
      });
      expect(await page('wave', 2, 2)).toEqual({ ids: ['carol'], count: 3 });
    });
  }
);
