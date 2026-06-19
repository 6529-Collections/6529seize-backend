import 'reflect-metadata';
import {
  DROPS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVE_CHAT_DROP_COOLDOWNS_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE,
  WAVE_READER_METRICS_TABLE
} from '@/constants';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { Time } from '@/time';
import { WavesApiDb, WaveSubwavesSort } from './waves.api.db';
import { ApiWaveScoreSort } from '../generated/models/ApiWaveScoreSort';
import { ApiWaveVisibilityTier } from '../generated/models/ApiWaveVisibilityTier';

const repo = new WavesApiDb(() => sqlExecutor);
const ctx: RequestContext = { timer: undefined };

const author = anIdentity(
  {},
  {
    consolidation_key: 'identity-wave-author',
    profile_id: 'profile-wave-author',
    primary_address: 'wallet-wave-author',
    handle: 'wave-author'
  }
);

const publicWave = aWave(
  {
    created_by: author.profile_id!,
    chat_links_disabled: true
  },
  { id: 'wave-public', serial_no: 1, name: 'Public Wave' }
);

const mutedHighScoreWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-muted-high-score', serial_no: 3, name: 'Muted High Score Wave' }
);

const visibleScoredWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-visible-score', serial_no: 4, name: 'Visible Score Wave' }
);

const privateWave = aWave(
  {
    created_by: author.profile_id!,
    visibility_group_id: 'visibility-group',
    admin_group_id: 'admin-group'
  },
  { id: 'wave-private', serial_no: 2, name: 'Private Wave' }
);

const parentWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-parent', serial_no: 10, name: 'Parent Wave' }
);

const alphaSubwave = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: parentWave.id
  },
  { id: 'wave-sub-alpha', serial_no: 11, name: 'Alpha Subwave' }
);

const betaSubwave = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: parentWave.id
  },
  { id: 'wave-sub-beta', serial_no: 12, name: 'Beta Subwave' }
);

const hiddenParentWave = aWave(
  {
    created_by: author.profile_id!,
    visibility_group_id: 'hidden-parent-group'
  },
  { id: 'wave-hidden-parent', serial_no: 13, name: 'Hidden Parent Wave' }
);

const publicSubwaveOfHiddenParent = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: hiddenParentWave.id
  },
  { id: 'wave-hidden-parent-child', serial_no: 14, name: 'Visible Child' }
);

const followedRootWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-followed-root', serial_no: 15, name: 'Followed Root Wave' }
);

const unfollowedDiscoveryWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-unfollowed-discovery', serial_no: 16, name: 'Unfollowed Wave' }
);

const mutedContainerParentWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-muted-container-parent', serial_no: 17, name: 'Muted Parent' }
);

const mutedContainerSubwave = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: mutedContainerParentWave.id
  },
  {
    id: 'wave-muted-container-child',
    serial_no: 18,
    name: 'Muted Parent Child'
  }
);

const mutedContainerComparatorWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-muted-container-comparator', serial_no: 19, name: 'Comparator' }
);

describeWithSeed(
  'WavesApiDb read visibility',
  [
    withIdentities([author]),
    withWaves([publicWave, privateWave]),
    {
      table: WAVE_DROPPER_METRICS_TABLE,
      rows: [
        {
          wave_id: publicWave.id,
          dropper_id: author.profile_id!,
          drops_count: 1,
          participatory_drops_count: 0,
          latest_drop_timestamp: 1001
        },
        {
          wave_id: privateWave.id,
          dropper_id: author.profile_id!,
          drops_count: 2,
          participatory_drops_count: 0,
          latest_drop_timestamp: 1002
        }
      ]
    }
  ],
  () => {
    it('does not read private waves through admin-group-only eligibility by ids', async () => {
      const adminOnlyResults = await repo.findWavesByIdsEligibleForRead(
        [publicWave.id, privateWave.id],
        ['admin-group'],
        undefined
      );
      expect(adminOnlyResults.map((wave) => wave.id)).toEqual([publicWave.id]);
      expect(adminOnlyResults[0]?.chat_links_disabled).toBe(true);

      const visibilityResults = await repo.findWavesByIdsEligibleForRead(
        [publicWave.id, privateWave.id],
        ['visibility-group'],
        undefined
      );
      expect(visibilityResults.map((wave) => wave.id).sort()).toEqual([
        privateWave.id,
        publicWave.id
      ]);
    });

    it('does not search private waves through admin-group-only eligibility', async () => {
      const baseParams = {
        limit: 10,
        direct_message: false
      };

      await expect(
        repo.searchWaves(baseParams, ['admin-group'], ctx)
      ).resolves.toEqual([expect.objectContaining({ id: publicWave.id })]);
      await expect(
        repo.searchWaves(baseParams, ['visibility-group'], ctx)
      ).resolves.toEqual([
        expect.objectContaining({ id: privateWave.id }),
        expect.objectContaining({ id: publicWave.id })
      ]);
    });

    it('does not return favorite private waves through admin-group-only eligibility', async () => {
      await expect(
        repo.findFavouriteWavesOfIdentity(
          {
            identityId: author.profile_id!,
            eligibleGroups: ['admin-group'],
            limit: 10,
            offset: 0
          },
          ctx
        )
      ).resolves.toEqual([expect.objectContaining({ id: publicWave.id })]);
      await expect(
        repo.findFavouriteWavesOfIdentity(
          {
            identityId: author.profile_id!,
            eligibleGroups: ['visibility-group'],
            limit: 10,
            offset: 0
          },
          ctx
        )
      ).resolves.toEqual([
        expect.objectContaining({ id: privateWave.id }),
        expect.objectContaining({ id: publicWave.id })
      ]);
    });
  }
);

describeWithSeed(
  'WavesApiDb followed subwave overview containers',
  [
    withIdentities([author]),
    withWaves([
      parentWave,
      alphaSubwave,
      betaSubwave,
      hiddenParentWave,
      publicSubwaveOfHiddenParent,
      followedRootWave,
      unfollowedDiscoveryWave
    ]),
    {
      table: WAVE_METRICS_TABLE,
      rows: [
        {
          wave_id: parentWave.id,
          latest_drop_timestamp: 100,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 60,
          wave_quality_score: 60,
          wave_hotness_score: 60,
          wave_rep_sort_score: 60
        },
        {
          wave_id: alphaSubwave.id,
          latest_drop_timestamp: 900,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 99,
          wave_quality_score: 99,
          wave_hotness_score: 99,
          wave_rep_sort_score: 99
        },
        {
          wave_id: betaSubwave.id,
          latest_drop_timestamp: 1000,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 95,
          wave_quality_score: 95,
          wave_hotness_score: 95,
          wave_rep_sort_score: 95
        },
        {
          wave_id: hiddenParentWave.id,
          latest_drop_timestamp: 50,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 80,
          wave_quality_score: 80,
          wave_hotness_score: 80,
          wave_rep_sort_score: 80
        },
        {
          wave_id: publicSubwaveOfHiddenParent.id,
          latest_drop_timestamp: 1100,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 90,
          wave_quality_score: 90,
          wave_hotness_score: 90,
          wave_rep_sort_score: 90
        },
        {
          wave_id: followedRootWave.id,
          latest_drop_timestamp: 500,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 70,
          wave_quality_score: 70,
          wave_hotness_score: 70,
          wave_rep_sort_score: 70
        },
        {
          wave_id: unfollowedDiscoveryWave.id,
          latest_drop_timestamp: 200,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 50,
          wave_quality_score: 50,
          wave_hotness_score: 50,
          wave_rep_sort_score: 50
        }
      ]
    },
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: [
        {
          subscriber_id: author.profile_id!,
          target_id: alphaSubwave.id,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED,
          wave_id: alphaSubwave.id,
          subscribed_to_all_drops: false
        },
        {
          subscriber_id: author.profile_id!,
          target_id: betaSubwave.id,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED,
          wave_id: betaSubwave.id,
          subscribed_to_all_drops: false
        },
        {
          subscriber_id: author.profile_id!,
          target_id: publicSubwaveOfHiddenParent.id,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED,
          wave_id: publicSubwaveOfHiddenParent.id,
          subscribed_to_all_drops: false
        },
        {
          subscriber_id: author.profile_id!,
          target_id: followedRootWave.id,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED,
          wave_id: followedRootWave.id,
          subscribed_to_all_drops: false
        }
      ]
    },
    {
      table: WAVE_READER_METRICS_TABLE,
      rows: [
        {
          wave_id: alphaSubwave.id,
          reader_id: author.profile_id!,
          latest_read_timestamp: 800,
          muted: false
        },
        {
          wave_id: betaSubwave.id,
          reader_id: author.profile_id!,
          latest_read_timestamp: 800,
          muted: true
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'alpha-unread-drop-1',
          wave_id: alphaSubwave.id,
          author_id: author.profile_id!,
          created_at: 850,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        },
        {
          id: 'alpha-unread-drop-2',
          wave_id: alphaSubwave.id,
          author_id: author.profile_id!,
          created_at: 900,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        },
        {
          id: 'beta-muted-drop',
          wave_id: betaSubwave.id,
          author_id: author.profile_id!,
          created_at: 1000,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        }
      ]
    }
  ],
  () => {
    it('returns parent containers for followed subwaves in activity order', async () => {
      const waves = await repo.findRecentlyDroppedToWaves({
        authenticated_user_id: author.profile_id!,
        only_waves_followed_by_authenticated_user: true,
        offset: 0,
        limit: 10,
        eligibleGroups: [],
        direct_message: false,
        pinned: null
      });

      expect(waves.map((wave) => wave.id)).toEqual([
        parentWave.id,
        followedRootWave.id
      ]);
    });

    it('uses parent score for followed-subwave containers in scored overviews', async () => {
      const waves = await repo.findScoredRecentlyDroppedToWaves({
        authenticated_user_id: author.profile_id!,
        only_waves_followed_by_authenticated_user: true,
        offset: 0,
        limit: 10,
        eligibleGroups: [],
        direct_message: false,
        pinned: null,
        score_sort: ApiWaveScoreSort.Quality,
        exclude_followed: false
      });

      expect(waves.map((wave) => wave.id)).toEqual([
        followedRootWave.id,
        parentWave.id
      ]);
    });

    it('excludes parents with followed subwaves from scored discovery', async () => {
      const waves = await repo.findScoredRecentlyDroppedToWaves({
        authenticated_user_id: author.profile_id!,
        only_waves_followed_by_authenticated_user: false,
        offset: 0,
        limit: 10,
        eligibleGroups: [],
        direct_message: false,
        pinned: null,
        score_sort: ApiWaveScoreSort.Quality,
        exclude_followed: true
      });

      expect(waves.map((wave) => wave.id)).toEqual([
        unfollowedDiscoveryWave.id
      ]);
    });

    it('summarizes hidden followed subwave activity and unread counts', async () => {
      const contexts =
        await repo.findFollowedSubwaveOverviewContextsByParentWaveId(
          {
            identityId: author.profile_id!,
            parentWaveIds: [parentWave.id],
            eligibleGroups: []
          },
          ctx
        );

      expect(contexts[parentWave.id]).toEqual({
        followed_subwaves_count: 2,
        latest_followed_subwave_activity_timestamp: 900,
        hidden_followed_subwave_unread_drops: 2,
        first_hidden_followed_subwave_unread_drop_serial_no: expect.any(Number)
      });
    });

    it('does not surface followed child aggregates for hidden parents', async () => {
      const contexts =
        await repo.findFollowedSubwaveOverviewContextsByParentWaveId(
          {
            identityId: author.profile_id!,
            parentWaveIds: [hiddenParentWave.id],
            eligibleGroups: []
          },
          ctx
        );

      expect(contexts[hiddenParentWave.id]).toBeUndefined();
    });
  }
);

describeWithSeed(
  'WavesApiDb followed subwave muted parent containers',
  [
    withIdentities([author]),
    withWaves([
      mutedContainerParentWave,
      mutedContainerSubwave,
      mutedContainerComparatorWave
    ]),
    {
      table: WAVE_METRICS_TABLE,
      rows: [
        {
          wave_id: mutedContainerParentWave.id,
          latest_drop_timestamp: 10,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 60,
          wave_quality_score: 60,
          wave_hotness_score: 60,
          wave_rep_sort_score: 60
        },
        {
          wave_id: mutedContainerSubwave.id,
          latest_drop_timestamp: 900,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 95,
          wave_quality_score: 95,
          wave_hotness_score: 95,
          wave_rep_sort_score: 95
        },
        {
          wave_id: mutedContainerComparatorWave.id,
          latest_drop_timestamp: 500,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 70,
          wave_quality_score: 70,
          wave_hotness_score: 70,
          wave_rep_sort_score: 70
        }
      ]
    },
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: [
        {
          subscriber_id: author.profile_id!,
          target_id: mutedContainerSubwave.id,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED,
          wave_id: mutedContainerSubwave.id,
          subscribed_to_all_drops: false
        },
        {
          subscriber_id: author.profile_id!,
          target_id: mutedContainerComparatorWave.id,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED,
          wave_id: mutedContainerComparatorWave.id,
          subscribed_to_all_drops: false
        }
      ]
    },
    {
      table: WAVE_READER_METRICS_TABLE,
      rows: [
        {
          wave_id: mutedContainerParentWave.id,
          reader_id: author.profile_id!,
          latest_read_timestamp: 0,
          muted: true
        },
        {
          wave_id: mutedContainerSubwave.id,
          reader_id: author.profile_id!,
          latest_read_timestamp: 100,
          muted: false
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'muted-parent-child-unread-drop',
          wave_id: mutedContainerSubwave.id,
          author_id: author.profile_id!,
          created_at: 900,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        }
      ]
    }
  ],
  () => {
    it('does not let followed child activity lift a muted parent container', async () => {
      const waves = await repo.findRecentlyDroppedToWaves({
        authenticated_user_id: author.profile_id!,
        only_waves_followed_by_authenticated_user: true,
        offset: 0,
        limit: 10,
        eligibleGroups: [],
        direct_message: false,
        pinned: null
      });

      expect(waves.map((wave) => wave.id)).toEqual([
        mutedContainerComparatorWave.id,
        mutedContainerParentWave.id
      ]);
    });

    it('does not surface hidden child unread counts for a muted parent', async () => {
      const contexts =
        await repo.findFollowedSubwaveOverviewContextsByParentWaveId(
          {
            identityId: author.profile_id!,
            parentWaveIds: [mutedContainerParentWave.id],
            eligibleGroups: []
          },
          ctx
        );

      expect(contexts[mutedContainerParentWave.id]).toEqual({
        followed_subwaves_count: 1,
        latest_followed_subwave_activity_timestamp: null,
        hidden_followed_subwave_unread_drops: 0,
        first_hidden_followed_subwave_unread_drop_serial_no: null
      });
    });
  }
);

describeWithSeed(
  'WavesApiDb scored overview filters',
  [
    withIdentities([author]),
    withWaves([mutedHighScoreWave, visibleScoredWave]),
    {
      table: WAVE_METRICS_TABLE,
      rows: [
        {
          wave_id: mutedHighScoreWave.id,
          latest_drop_timestamp: 3002,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 99,
          wave_quality_score: 99,
          wave_hotness_score: 99,
          wave_rep_sort_score: 99
        },
        {
          wave_id: visibleScoredWave.id,
          latest_drop_timestamp: 3001,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 70,
          wave_quality_score: 70,
          wave_hotness_score: 70,
          wave_rep_sort_score: 70
        }
      ]
    },
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: [
        {
          subscriber_id: author.profile_id!,
          target_id: mutedHighScoreWave.id,
          target_type: ActivityEventTargetType.WAVE,
          target_action: ActivityEventAction.DROP_CREATED,
          wave_id: mutedHighScoreWave.id,
          subscribed_to_all_drops: false
        }
      ]
    },
    {
      table: WAVE_READER_METRICS_TABLE,
      rows: [
        {
          wave_id: mutedHighScoreWave.id,
          reader_id: author.profile_id!,
          latest_read_timestamp: 0,
          muted: true
        }
      ]
    }
  ],
  () => {
    it('applies muted score floors to scored min filters and tier filters', async () => {
      const waves = await repo.findScoredRecentlyDroppedToWaves({
        authenticated_user_id: author.profile_id!,
        only_waves_followed_by_authenticated_user: false,
        offset: 0,
        limit: 10,
        eligibleGroups: [],
        direct_message: false,
        pinned: null,
        score_sort: ApiWaveScoreSort.Balanced,
        exclude_followed: false,
        min_visibility_score: 50,
        min_quality_score: 50,
        min_hotness_score: 50,
        min_rep_sort_score: 50,
        visibility_tier: ApiWaveVisibilityTier.TrustedVisible
      });

      expect(waves.map((wave) => wave.id)).toEqual([visibleScoredWave.id]);
    });

    it('excludes followed waves from scored sort results', async () => {
      const waves = await repo.findScoredRecentlyDroppedToWaves({
        authenticated_user_id: author.profile_id!,
        only_waves_followed_by_authenticated_user: false,
        offset: 0,
        limit: 10,
        eligibleGroups: [],
        direct_message: false,
        pinned: null,
        score_sort: ApiWaveScoreSort.Quality,
        exclude_followed: true
      });

      expect(waves.map((wave) => wave.id)).toEqual([visibleScoredWave.id]);
    });

    it('rejects conflicting followed-only and exclude-followed scored filters', async () => {
      await expect(
        repo.findScoredRecentlyDroppedToWaves({
          authenticated_user_id: author.profile_id!,
          only_waves_followed_by_authenticated_user: true,
          offset: 0,
          limit: 10,
          eligibleGroups: [],
          direct_message: false,
          pinned: null,
          score_sort: ApiWaveScoreSort.Quality,
          exclude_followed: true
        })
      ).rejects.toThrow(
        'Cannot request followed-only waves and exclude-followed waves together'
      );
    });
  }
);

describeWithSeed(
  'WavesApiDb subwaves',
  [
    withIdentities([author]),
    withWaves([
      parentWave,
      alphaSubwave,
      betaSubwave,
      hiddenParentWave,
      publicSubwaveOfHiddenParent
    ]),
    {
      table: WAVE_DROPPER_METRICS_TABLE,
      rows: [
        {
          wave_id: alphaSubwave.id,
          dropper_id: author.profile_id!,
          drops_count: 5,
          participatory_drops_count: 0,
          latest_drop_timestamp: 2005
        },
        {
          wave_id: betaSubwave.id,
          dropper_id: author.profile_id!,
          drops_count: 4,
          participatory_drops_count: 0,
          latest_drop_timestamp: 2004
        }
      ]
    }
  ],
  () => {
    it('excludes subwaves from top-level search results', async () => {
      const waves = await repo.searchWaves(
        {
          limit: 10,
          direct_message: false
        },
        ['hidden-parent-group'],
        ctx
      );

      expect(waves.map((wave) => wave.id)).toEqual([
        hiddenParentWave.id,
        parentWave.id
      ]);
    });

    it('lists visible subwaves alphabetically by default', async () => {
      const subwaves = await repo.findSubwaves(
        {
          parentWaveId: parentWave.id,
          eligibleGroups: [],
          limit: 10,
          offset: 0,
          sort: WaveSubwavesSort.NAME
        },
        ctx
      );

      expect(subwaves.map((wave) => wave.id)).toEqual([
        alphaSubwave.id,
        betaSubwave.id
      ]);
    });

    it('hides subwaves when the parent is not visible', async () => {
      await expect(
        repo.findWavesByIdsEligibleForRead(
          [publicSubwaveOfHiddenParent.id],
          [],
          undefined
        )
      ).resolves.toEqual([]);

      await expect(
        repo.findWavesByIdsEligibleForRead(
          [publicSubwaveOfHiddenParent.id],
          ['hidden-parent-group'],
          undefined
        )
      ).resolves.toEqual([
        expect.objectContaining({ id: publicSubwaveOfHiddenParent.id })
      ]);
    });
  }
);

const slowModeCooldownMs = Time.minutes(5).toMillis();
const recentDropTimestamp = Time.minutesAgo(1).toMillis();
const expiredDropTimestamp = Time.minutesAgo(10).toMillis();
const staleCooldownTimestamp = Time.minutesFromNow(30).toMillis();
const slowModeWave = aWave(
  {
    created_by: author.profile_id!,
    chat_slow_mode_cooldown_ms: slowModeCooldownMs
  },
  { id: 'wave-slow-mode', serial_no: 3, name: 'Slow Mode Wave' }
);
const reserveSlowModeWave = aWave(
  {
    created_by: author.profile_id!,
    chat_slow_mode_cooldown_ms: slowModeCooldownMs
  },
  { id: 'wave-slow-mode-reserve', serial_no: 4, name: 'Slow Reserve Wave' }
);

describeWithSeed(
  'WavesApiDb chat slow mode cooldown reads',
  [
    withIdentities([author]),
    withWaves([slowModeWave]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'recent-chat-drop',
          wave_id: slowModeWave.id,
          author_id: author.profile_id!,
          created_at: recentDropTimestamp,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        }
      ]
    }
  ],
  () => {
    it('infers next drop timestamp from recent chat drops when no cooldown row exists', async () => {
      await expect(
        repo.findWaveChatDropCooldownsByWaveIds(
          {
            profileId: author.profile_id!,
            waveIds: [slowModeWave.id]
          },
          ctx
        )
      ).resolves.toEqual({
        [slowModeWave.id]: expect.objectContaining({
          wave_id: slowModeWave.id,
          profile_id: author.profile_id!,
          next_drop_timestamp: recentDropTimestamp + slowModeCooldownMs
        })
      });
    });
  }
);

describeWithSeed(
  'WavesApiDb chat slow mode cooldown reconciliation',
  [
    withIdentities([author]),
    withWaves([slowModeWave, reserveSlowModeWave]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'recent-chat-drop',
          wave_id: slowModeWave.id,
          author_id: author.profile_id!,
          created_at: recentDropTimestamp,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        },
        {
          id: 'expired-chat-drop',
          wave_id: reserveSlowModeWave.id,
          author_id: author.profile_id!,
          created_at: expiredDropTimestamp,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        }
      ]
    },
    {
      table: WAVE_CHAT_DROP_COOLDOWNS_TABLE,
      rows: [
        {
          wave_id: slowModeWave.id,
          profile_id: author.profile_id!,
          next_drop_timestamp: staleCooldownTimestamp,
          created_at: 1,
          updated_at: 1
        },
        {
          wave_id: reserveSlowModeWave.id,
          profile_id: author.profile_id!,
          next_drop_timestamp: staleCooldownTimestamp,
          created_at: 1,
          updated_at: 1
        }
      ]
    }
  ],
  () => {
    it('recomputes and persists stale stored cooldown rows on read', async () => {
      const expectedNextDropTimestamp =
        recentDropTimestamp + slowModeCooldownMs;

      await expect(
        repo.findWaveChatDropCooldownsByWaveIds(
          {
            profileId: author.profile_id!,
            waveIds: [slowModeWave.id]
          },
          ctx
        )
      ).resolves.toEqual({
        [slowModeWave.id]: expect.objectContaining({
          wave_id: slowModeWave.id,
          profile_id: author.profile_id!,
          next_drop_timestamp: expectedNextDropTimestamp
        })
      });

      const stored = await sqlExecutor.oneOrNull<{
        next_drop_timestamp: number;
      }>(
        `select next_drop_timestamp
         from ${WAVE_CHAT_DROP_COOLDOWNS_TABLE}
         where wave_id = :waveId and profile_id = :profileId`,
        { waveId: slowModeWave.id, profileId: author.profile_id! }
      );
      expect(Number(stored?.next_drop_timestamp)).toBe(
        expectedNextDropTimestamp
      );
    });

    it('recomputes stale stored cooldown rows before enforcing reserve', async () => {
      const now = Time.currentMillis();

      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await expect(
            repo.reserveWaveChatDropCooldown(
              {
                waveId: reserveSlowModeWave.id,
                profileId: author.profile_id!,
                now,
                cooldownMs: Time.hours(1).toMillis()
              },
              { timer: undefined, connection }
            )
          ).resolves.toBeNull();
        }
      );

      const stored = await sqlExecutor.oneOrNull<{
        next_drop_timestamp: number;
      }>(
        `select next_drop_timestamp
         from ${WAVE_CHAT_DROP_COOLDOWNS_TABLE}
         where wave_id = :waveId and profile_id = :profileId`,
        { waveId: reserveSlowModeWave.id, profileId: author.profile_id! }
      );
      expect(Number(stored?.next_drop_timestamp)).toBe(
        now + slowModeCooldownMs
      );
    });
  }
);
