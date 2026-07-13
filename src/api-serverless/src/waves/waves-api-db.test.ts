import 'reflect-metadata';
import {
  DROPS_TABLE,
  IDENTITY_MUTES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PINNED_WAVES_TABLE,
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
import { ApiWavesPinFilter } from '../generated/models/ApiWavesPinFilter';
import { WaveOverviewCandidate } from './wave-overview-candidate-cache';

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
const unreadReader = anIdentity(
  {},
  {
    consolidation_key: 'identity-unread-reader',
    profile_id: 'profile-unread-reader',
    primary_address: 'wallet-unread-reader',
    handle: 'unread-reader'
  }
);
const mutedUnreadReader = anIdentity(
  {},
  {
    consolidation_key: 'identity-muted-unread-reader',
    profile_id: 'profile-muted-unread-reader',
    primary_address: 'wallet-muted-unread-reader',
    handle: 'muted-unread-reader'
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

const unfollowedUnreadSubwave = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: parentWave.id
  },
  { id: 'wave-sub-unfollowed', serial_no: 101, name: 'Unfollowed Subwave' }
);

const unfollowedOnlyParentWave = aWave(
  {
    created_by: author.profile_id!
  },
  {
    id: 'wave-unfollowed-only-parent',
    serial_no: 102,
    name: 'Unfollowed Only Parent'
  }
);

const unfollowedOnlySubwave = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: unfollowedOnlyParentWave.id
  },
  {
    id: 'wave-unfollowed-only-child',
    serial_no: 103,
    name: 'Unfollowed Only Child'
  }
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

const pinnedCandidateWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-pinned-candidate', serial_no: 20, name: 'Pinned Candidate' }
);

const unpinnedCandidateWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-unpinned-candidate', serial_no: 21, name: 'Unpinned Candidate' }
);

type CandidateFallbackTestRepo = {
  sortRecentlyDroppedCandidates: (
    candidates: WaveOverviewCandidate[]
  ) => WaveOverviewCandidate[];
  sortScoredCandidates: (
    candidates: WaveOverviewCandidate[]
  ) => WaveOverviewCandidate[];
  findRecentlyDroppedToWavesFromCandidates: (
    param: Record<string, unknown>
  ) => Promise<readonly { id: string }[] | null>;
  findScoredRecentlyDroppedToWavesFromCandidates: (
    param: Record<string, unknown>
  ) => Promise<readonly { id: string }[] | null>;
  findRecentlyDroppedToWaveCandidates: jest.Mock;
  findScoredRecentlyDroppedToWaveCandidates: jest.Mock;
  findPinnedCandidateWaveIds: jest.Mock;
  findMutedCandidateWaveIds: jest.Mock;
  findVisibleCandidatePageOrFallback: jest.Mock;
};

function buildCandidateWindow(count: number): WaveOverviewCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    waveId: `candidate-wave-${index}`,
    tierRank: 1,
    sortVal: count - index,
    latestDropTimestamp: count - index
  }));
}

function getWaveIds(waves: readonly { id: string }[] | null): string[] {
  if (!waves) {
    throw new Error('Expected wave list');
  }
  return waves.map((wave) => wave.id);
}

function buildLegacyOverviewRepo(): WavesApiDb {
  const legacyRepo = new WavesApiDb(() => sqlExecutor);
  const candidateMethods = legacyRepo as unknown as Pick<
    CandidateFallbackTestRepo,
    | 'findRecentlyDroppedToWavesFromCandidates'
    | 'findScoredRecentlyDroppedToWavesFromCandidates'
  >;
  candidateMethods.findRecentlyDroppedToWavesFromCandidates = jest
    .fn()
    .mockResolvedValue(null);
  candidateMethods.findScoredRecentlyDroppedToWavesFromCandidates = jest
    .fn()
    .mockResolvedValue(null);
  return legacyRepo;
}

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

describe('WavesApiDb overview candidate fallback guards', () => {
  const baseParams = {
    authenticated_user_id: author.profile_id!,
    only_waves_followed_by_authenticated_user: false,
    offset: 0,
    limit: 20,
    eligibleGroups: [],
    direct_message: false,
    pinned: null
  };

  it('uses SQL-compatible id-desc tie-breakers for candidate ordering', () => {
    const testRepo = new WavesApiDb(
      () => sqlExecutor
    ) as unknown as CandidateFallbackTestRepo;
    const tiedCandidates: WaveOverviewCandidate[] = [
      {
        waveId: 'wave-a',
        tierRank: 1,
        sortVal: 100,
        latestDropTimestamp: 100
      },
      {
        waveId: 'wave_',
        tierRank: 1,
        sortVal: 100,
        latestDropTimestamp: 100
      }
    ];

    expect(
      testRepo
        .sortRecentlyDroppedCandidates(tiedCandidates)
        .map((candidate) => candidate.waveId)
    ).toEqual(['wave_', 'wave-a']);
    expect(
      testRepo
        .sortScoredCandidates(tiedCandidates)
        .map((candidate) => candidate.waveId)
    ).toEqual(['wave_', 'wave-a']);
  });

  it('falls back for recently dropped candidates when muting affects a full window', async () => {
    const testRepo = new WavesApiDb(
      () => sqlExecutor
    ) as unknown as CandidateFallbackTestRepo;
    const candidates = buildCandidateWindow(250);
    testRepo.findRecentlyDroppedToWaveCandidates = jest
      .fn()
      .mockResolvedValue(candidates);
    testRepo.findPinnedCandidateWaveIds = jest
      .fn()
      .mockResolvedValue(new Set());
    testRepo.findMutedCandidateWaveIds = jest
      .fn()
      .mockResolvedValue(new Set([candidates[0]!.waveId]));
    testRepo.findVisibleCandidatePageOrFallback = jest.fn();

    await expect(
      testRepo.findRecentlyDroppedToWavesFromCandidates(baseParams)
    ).resolves.toBeNull();
    expect(testRepo.findVisibleCandidatePageOrFallback).not.toHaveBeenCalled();
  });

  it('falls back for scored candidates when muting affects a full window', async () => {
    const testRepo = new WavesApiDb(
      () => sqlExecutor
    ) as unknown as CandidateFallbackTestRepo;
    const candidates = buildCandidateWindow(250);
    testRepo.findScoredRecentlyDroppedToWaveCandidates = jest
      .fn()
      .mockResolvedValue(candidates);
    testRepo.findPinnedCandidateWaveIds = jest
      .fn()
      .mockResolvedValue(new Set());
    testRepo.findMutedCandidateWaveIds = jest
      .fn()
      .mockResolvedValue(new Set([candidates[0]!.waveId]));
    testRepo.findVisibleCandidatePageOrFallback = jest.fn();

    await expect(
      testRepo.findScoredRecentlyDroppedToWavesFromCandidates({
        ...baseParams,
        score_sort: ApiWaveScoreSort.Balanced,
        exclude_followed: false
      })
    ).resolves.toBeNull();
    expect(testRepo.findVisibleCandidatePageOrFallback).not.toHaveBeenCalled();
  });
});

describeWithSeed(
  'WavesApiDb overview candidate safety',
  [
    withIdentities([author]),
    withWaves([
      publicWave,
      privateWave,
      pinnedCandidateWave,
      unpinnedCandidateWave
    ]),
    {
      table: WAVE_METRICS_TABLE,
      rows: [
        {
          wave_id: publicWave.id,
          latest_drop_timestamp: 100,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 40,
          wave_quality_score: 40,
          wave_hotness_score: 40,
          wave_rep_sort_score: 40
        },
        {
          wave_id: privateWave.id,
          latest_drop_timestamp: 200,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 90,
          wave_quality_score: 90,
          wave_hotness_score: 90,
          wave_rep_sort_score: 90
        },
        {
          wave_id: pinnedCandidateWave.id,
          latest_drop_timestamp: 300,
          wave_visibility_tier: ApiWaveVisibilityTier.TrustedVisible,
          wave_visibility_rank: 1,
          wave_visibility_score: 60,
          wave_quality_score: 60,
          wave_hotness_score: 60,
          wave_rep_sort_score: 60
        },
        {
          wave_id: unpinnedCandidateWave.id,
          latest_drop_timestamp: 400,
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
      table: PINNED_WAVES_TABLE,
      rows: [
        {
          wave_id: pinnedCandidateWave.id,
          profile_id: author.profile_id!
        }
      ]
    }
  ],
  () => {
    it('keeps scored candidate results behind current visibility groups', async () => {
      await expect(
        repo.findScoredRecentlyDroppedToWaves({
          authenticated_user_id: null,
          only_waves_followed_by_authenticated_user: false,
          offset: 0,
          limit: 10,
          eligibleGroups: [],
          direct_message: false,
          pinned: null,
          score_sort: ApiWaveScoreSort.Balanced,
          exclude_followed: false
        })
      ).resolves.toEqual([
        expect.objectContaining({ id: unpinnedCandidateWave.id }),
        expect.objectContaining({ id: pinnedCandidateWave.id }),
        expect.objectContaining({ id: publicWave.id })
      ]);

      await expect(
        repo.findScoredRecentlyDroppedToWaves({
          authenticated_user_id: null,
          only_waves_followed_by_authenticated_user: false,
          offset: 0,
          limit: 10,
          eligibleGroups: ['visibility-group'],
          direct_message: false,
          pinned: null,
          score_sort: ApiWaveScoreSort.Balanced,
          exclude_followed: false
        })
      ).resolves.toEqual([
        expect.objectContaining({ id: privateWave.id }),
        expect.objectContaining({ id: unpinnedCandidateWave.id }),
        expect.objectContaining({ id: pinnedCandidateWave.id }),
        expect.objectContaining({ id: publicWave.id })
      ]);
    });

    it('applies pin filters from live per-user state after candidate ranking', async () => {
      await expect(
        repo.findRecentlyDroppedToWaves({
          authenticated_user_id: author.profile_id!,
          only_waves_followed_by_authenticated_user: false,
          offset: 0,
          limit: 10,
          eligibleGroups: [],
          direct_message: false,
          pinned: ApiWavesPinFilter.Pinned
        })
      ).resolves.toEqual([
        expect.objectContaining({ id: pinnedCandidateWave.id })
      ]);

      await expect(
        repo.findRecentlyDroppedToWaves({
          authenticated_user_id: author.profile_id!,
          only_waves_followed_by_authenticated_user: false,
          offset: 0,
          limit: 10,
          eligibleGroups: [],
          direct_message: false,
          pinned: ApiWavesPinFilter.NotPinned
        })
      ).resolves.toEqual([
        expect.objectContaining({ id: unpinnedCandidateWave.id }),
        expect.objectContaining({ id: publicWave.id })
      ]);
    });
  }
);

describeWithSeed(
  'WavesApiDb followed subwave overview containers',
  [
    withIdentities([author, unreadReader, mutedUnreadReader]),
    withWaves([
      parentWave,
      alphaSubwave,
      betaSubwave,
      unfollowedUnreadSubwave,
      unfollowedOnlyParentWave,
      unfollowedOnlySubwave,
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
      table: IDENTITY_MUTES_TABLE,
      rows: [
        {
          muter_id: author.profile_id!,
          muted_identity_id: mutedUnreadReader.profile_id!,
          created_at: 1
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
        },
        {
          wave_id: unfollowedUnreadSubwave.id,
          reader_id: author.profile_id!,
          latest_read_timestamp: 800,
          muted: false
        },
        {
          wave_id: unfollowedOnlySubwave.id,
          reader_id: author.profile_id!,
          latest_read_timestamp: 800,
          muted: false
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
          id: 'alpha-other-author-unread-drop',
          wave_id: alphaSubwave.id,
          author_id: unreadReader.profile_id!,
          created_at: 875,
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
          id: 'alpha-muted-author-unread-drop',
          wave_id: alphaSubwave.id,
          author_id: mutedUnreadReader.profile_id!,
          created_at: 880,
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
        },
        {
          id: 'unfollowed-subwave-unread-drop',
          wave_id: unfollowedUnreadSubwave.id,
          author_id: unreadReader.profile_id!,
          created_at: 950,
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
          id: 'unfollowed-only-subwave-unread-drop',
          wave_id: unfollowedOnlySubwave.id,
          author_id: unreadReader.profile_id!,
          created_at: 975,
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

    it('summarizes followed activity and all visible subwave unread counts', async () => {
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
        subwave_unread_drops: 2,
        hidden_followed_subwave_unread_drops: 1,
        first_hidden_followed_subwave_unread_drop_serial_no: expect.any(Number)
      });
    });

    it('returns subwave unread counts when no child is followed', async () => {
      const contexts =
        await repo.findFollowedSubwaveOverviewContextsByParentWaveId(
          {
            identityId: author.profile_id!,
            parentWaveIds: [unfollowedOnlyParentWave.id],
            eligibleGroups: []
          },
          ctx
        );

      expect(contexts[unfollowedOnlyParentWave.id]).toEqual({
        followed_subwaves_count: 0,
        latest_followed_subwave_activity_timestamp: null,
        subwave_unread_drops: 1,
        hidden_followed_subwave_unread_drops: 0,
        first_hidden_followed_subwave_unread_drop_serial_no: null
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
        subwave_unread_drops: 0,
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
    it('matches legacy recently-dropped ordering for muted waves in partial candidate windows', async () => {
      const params = {
        authenticated_user_id: author.profile_id!,
        only_waves_followed_by_authenticated_user: false,
        offset: 0,
        limit: 10,
        eligibleGroups: [],
        direct_message: false,
        pinned: null
      };
      const candidateMethods = repo as unknown as CandidateFallbackTestRepo;
      const candidatePathWaves =
        await candidateMethods.findRecentlyDroppedToWavesFromCandidates(params);
      const candidateWaves = await repo.findRecentlyDroppedToWaves(params);
      const legacyWaves =
        await buildLegacyOverviewRepo().findRecentlyDroppedToWaves(params);

      expect(getWaveIds(candidatePathWaves)).toEqual([
        visibleScoredWave.id,
        mutedHighScoreWave.id
      ]);
      expect(getWaveIds(candidateWaves)).toEqual(getWaveIds(legacyWaves));
    });

    it('matches legacy scored ordering for muted waves in partial candidate windows', async () => {
      const params = {
        authenticated_user_id: author.profile_id!,
        only_waves_followed_by_authenticated_user: false,
        offset: 0,
        limit: 10,
        eligibleGroups: [],
        direct_message: false,
        pinned: null,
        score_sort: ApiWaveScoreSort.Quality,
        exclude_followed: false
      };
      const candidateMethods = repo as unknown as CandidateFallbackTestRepo;
      const candidatePathWaves =
        await candidateMethods.findScoredRecentlyDroppedToWavesFromCandidates(
          params
        );
      const candidateWaves =
        await repo.findScoredRecentlyDroppedToWaves(params);
      const legacyWaves =
        await buildLegacyOverviewRepo().findScoredRecentlyDroppedToWaves(
          params
        );

      expect(getWaveIds(candidatePathWaves)).toEqual([
        visibleScoredWave.id,
        mutedHighScoreWave.id
      ]);
      expect(getWaveIds(candidateWaves)).toEqual(getWaveIds(legacyWaves));
    });

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
    it('includes visible subwaves in search results', async () => {
      const waves = await repo.searchWaves(
        {
          limit: 10,
          name: 'Subwave',
          direct_message: false
        },
        [],
        ctx
      );

      expect(waves.map((wave) => wave.id)).toEqual([
        betaSubwave.id,
        alphaSubwave.id
      ]);
    });

    it('hides search results for subwaves whose parent is not visible', async () => {
      const waves = await repo.searchWaves(
        {
          limit: 10,
          name: 'Visible Child',
          direct_message: false
        },
        [],
        ctx
      );

      expect(waves.map((wave) => wave.id)).toEqual([]);
    });

    it('returns subwaves of hidden parents when the parent is visible to the user', async () => {
      const waves = await repo.searchWaves(
        {
          limit: 10,
          name: 'Visible Child',
          direct_message: false
        },
        ['hidden-parent-group'],
        ctx
      );

      expect(waves.map((wave) => wave.id)).toEqual([
        publicSubwaveOfHiddenParent.id
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

const unreadSummaryWave = aWave(
  {
    created_by: author.profile_id!
  },
  { id: 'wave-unread-summary', serial_no: 30, name: 'Unread Summary Wave' }
);
const noUnreadSummaryWave = aWave(
  {
    created_by: author.profile_id!
  },
  {
    id: 'wave-no-unread-summary',
    serial_no: 31,
    name: 'No Unread Summary Wave'
  }
);
const mutedUnreadSummaryWave = aWave(
  {
    created_by: author.profile_id!
  },
  {
    id: 'wave-muted-unread-summary',
    serial_no: 32,
    name: 'Muted Unread Summary Wave'
  }
);
const noReaderMetricUnreadSummaryWave = aWave(
  {
    created_by: author.profile_id!,
    is_direct_message: false
  },
  {
    id: 'wave-no-reader-metric-unread-summary',
    serial_no: 33,
    name: 'No Reader Metric Unread Summary Wave'
  }
);
const seededReaderMetricUnreadSummaryWave = aWave(
  {
    created_by: author.profile_id!
  },
  {
    id: 'wave-seeded-reader-metric-unread-summary',
    serial_no: 34,
    name: 'Seeded Reader Metric Unread Summary Wave'
  }
);

describeWithSeed(
  'WavesApiDb unread summaries',
  [
    withIdentities([author, unreadReader]),
    withWaves([
      unreadSummaryWave,
      noUnreadSummaryWave,
      mutedUnreadSummaryWave,
      noReaderMetricUnreadSummaryWave,
      seededReaderMetricUnreadSummaryWave
    ]),
    {
      table: WAVE_READER_METRICS_TABLE,
      rows: [
        {
          wave_id: unreadSummaryWave.id,
          reader_id: unreadReader.profile_id!,
          latest_read_timestamp: 1000,
          muted: false
        },
        {
          wave_id: mutedUnreadSummaryWave.id,
          reader_id: unreadReader.profile_id!,
          latest_read_timestamp: 1000,
          muted: true
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        {
          serial_no: 21,
          id: 'read-drop-before-timestamp',
          wave_id: unreadSummaryWave.id,
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
          serial_no: 22,
          id: 'first-unread-summary-drop',
          wave_id: unreadSummaryWave.id,
          author_id: author.profile_id!,
          created_at: 1100,
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
          serial_no: 23,
          id: 'second-unread-summary-drop',
          wave_id: unreadSummaryWave.id,
          author_id: author.profile_id!,
          created_at: 1200,
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
          serial_no: 24,
          id: 'muted-unread-summary-drop',
          wave_id: mutedUnreadSummaryWave.id,
          author_id: author.profile_id!,
          created_at: 1200,
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
          serial_no: 25,
          id: 'reader-authored-summary-drop',
          wave_id: unreadSummaryWave.id,
          author_id: unreadReader.profile_id!,
          created_at: 1300,
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
          serial_no: 26,
          id: 'no-reader-metric-unread-summary-drop',
          wave_id: noReaderMetricUnreadSummaryWave.id,
          author_id: author.profile_id!,
          created_at: 1400,
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
          serial_no: 27,
          id: 'no-reader-metric-reader-authored-summary-drop',
          wave_id: noReaderMetricUnreadSummaryWave.id,
          author_id: unreadReader.profile_id!,
          created_at: 1500,
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
          serial_no: 28,
          id: 'seeded-reader-metric-old-summary-drop',
          wave_id: seededReaderMetricUnreadSummaryWave.id,
          author_id: author.profile_id!,
          created_at: 1300,
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
          serial_no: 29,
          id: 'seeded-reader-metric-current-summary-drop',
          wave_id: seededReaderMetricUnreadSummaryWave.id,
          author_id: author.profile_id!,
          created_at: 1400,
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
    it('returns unread counts and first unread serials from one summary read', async () => {
      await expect(
        repo.findIdentityUnreadDropsSummaryByWaveId(
          {
            identityId: unreadReader.profile_id!,
            waveIds: [
              unreadSummaryWave.id,
              noUnreadSummaryWave.id,
              mutedUnreadSummaryWave.id,
              noReaderMetricUnreadSummaryWave.id
            ]
          },
          ctx
        )
      ).resolves.toEqual({
        [unreadSummaryWave.id]: {
          unread_drops_count: 2,
          first_unread_drop_serial_no: 22
        },
        [noUnreadSummaryWave.id]: {
          unread_drops_count: 0,
          first_unread_drop_serial_no: null
        },
        [mutedUnreadSummaryWave.id]: {
          unread_drops_count: 0,
          first_unread_drop_serial_no: null
        },
        [noReaderMetricUnreadSummaryWave.id]: {
          unread_drops_count: 0,
          first_unread_drop_serial_no: null
        }
      });
    });

    it('does not infer unread history for a non-DM wave without reader metrics', async () => {
      await expect(
        repo.findIdentityUnreadDropsSummaryByWaveId(
          {
            identityId: unreadReader.profile_id!,
            waveIds: [noReaderMetricUnreadSummaryWave.id]
          },
          ctx
        )
      ).resolves.toEqual({
        [noReaderMetricUnreadSummaryWave.id]: {
          unread_drops_count: 0,
          first_unread_drop_serial_no: null
        }
      });
    });

    it('counts only drops after an explicitly seeded reader metric', async () => {
      await repo.insertMissingWaveReaderMetrics(
        {
          waveId: seededReaderMetricUnreadSummaryWave.id,
          readerIds: [unreadReader.profile_id!],
          latestReadTimestamp: 1399
        },
        ctx
      );

      await expect(
        repo.findIdentityUnreadDropsSummaryByWaveId(
          {
            identityId: unreadReader.profile_id!,
            waveIds: [seededReaderMetricUnreadSummaryWave.id]
          },
          ctx
        )
      ).resolves.toEqual({
        [seededReaderMetricUnreadSummaryWave.id]: {
          unread_drops_count: 1,
          first_unread_drop_serial_no: 29
        }
      });
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
