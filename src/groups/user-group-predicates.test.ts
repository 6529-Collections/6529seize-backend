import {
  getUserGroupDirectionOrDefault,
  hasGroupGotAnyNonIdentityConditions,
  hasGroupGotOwnsGradientCriteria,
  hasGroupGotOwnsLabCriteria,
  hasGroupGotOwnsMemeCriteria,
  hasGroupGotOwnsNextGenCriteria,
  hasGroupGotProfileCicCriteria,
  hasGroupGotProfileLevelCriteria,
  hasGroupGotProfileRepCriteria,
  hasGroupGotProfileTdhCriteria,
  hasGroupGotTotalSentCicCriteria,
  hasGroupGotTotalSentRepCriteria,
  isAnyGroupByOwningsCriteria,
  isAnyGroupByTotalSentCicOrRepCriteria,
  isGroupByOwningsCriteria,
  isGroupTotalCicByUserIncoming,
  isGroupTotalCicByUserOutgoing,
  isGroupTotalRepByUserForCategoryIncoming,
  isGroupTotalRepByUserForCategoryOutgoing,
  isGroupTotalRepByUserIncoming,
  isGroupTotalRepByUserOutgoing,
  isGroupTotalRepForCategoryIncoming,
  isGroupTotalRepForCategoryOutgoing,
  isGroupViolatingAnySpecificCicCriteria,
  isGroupViolatingAnySpecificRepCriteria,
  isProfileHavingContractTokenOwningsMisMatch,
  isProfileViolatingGradientCriteria,
  isProfileViolatingGroupsProfileCicCriteria,
  isProfileViolatingGroupsProfileLevelCriteria,
  isProfileViolatingGroupsProfileRepCriteria,
  isProfileViolatingGroupsProfileTdhCriteria,
  isProfileViolatingLabCriteria,
  isProfileViolatingMemesCriteria,
  isProfileViolatingOwnsCriteria,
  isProfileViolatingOwnsNextGenCriteria,
  isProfileViolatingTotalSentCicCriteria,
  isProfileViolatingTotalSentRepCriteria,
  isRatingOutOfBounds,
  ProfileSimpleMetrics
} from './user-group-predicates';
import {
  FilterDirection,
  GroupTdhInclusionStrategy,
  UserGroupEntity
} from '../entities/IUserGroup';
import { Time } from '../time';
import { NEXTGEN_CORE_CONTRACT } from '../nextgen/nextgen_constants';
import { Network } from 'alchemy-sdk';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { RateMatter } from '../entities/IRating';

function aProfile({
  tdh,
  xtdh,
  level,
  cic,
  rep
}: {
  tdh?: number;
  xtdh?: number;
  level?: number;
  cic?: number;
  rep?: number;
}): ProfileSimpleMetrics {
  return {
    profile_id: 'a-profile-id',
    tdh: tdh ?? 0,
    xtdh: xtdh ?? 0,
    level: level ?? 0,
    cic: cic ?? 0,
    rep: rep ?? 0
  };
}

function aGroup({
  cic_min,
  cic_max,
  cic_user,
  cic_direction,
  rep_min,
  rep_max,
  rep_user,
  rep_direction,
  rep_category,
  tdh_min,
  tdh_max,
  tdh_inclusion_strategy,
  level_min,
  level_max,
  owns_meme,
  owns_meme_tokens,
  owns_gradient,
  owns_gradient_tokens,
  owns_nextgen,
  owns_nextgen_tokens,
  owns_lab,
  owns_lab_tokens,
  profile_group_id,
  excluded_profile_group_id,
  is_beneficiary_of_grant_id
}: {
  cic_min?: number | null;
  cic_max?: number | null;
  cic_user?: string | null;
  cic_direction?: FilterDirection | null;
  rep_min?: number | null;
  rep_max?: number | null;
  rep_user?: string | null;
  rep_direction?: FilterDirection | null;
  rep_category?: string | null;
  tdh_min?: number | null;
  tdh_max?: number | null;
  tdh_inclusion_strategy?: GroupTdhInclusionStrategy | null;
  level_min?: number | null;
  level_max?: number | null;
  owns_meme?: boolean | null;
  owns_meme_tokens?: string | null;
  owns_gradient?: boolean | null;
  owns_gradient_tokens?: string | null;
  owns_nextgen?: boolean | null;
  owns_nextgen_tokens?: string | null;
  owns_lab?: boolean | null;
  owns_lab_tokens?: string | null;
  profile_group_id?: string | null;
  excluded_profile_group_id?: string | null;
  is_beneficiary_of_grant_id?: string | null;
}): UserGroupEntity {
  return {
    id: 'a-group-id',
    name: 'A Group',
    cic_min: cic_min ?? null,
    cic_max: cic_max ?? null,
    cic_user: cic_user ?? null,
    cic_direction: cic_direction ?? null,
    rep_min: rep_min ?? null,
    rep_max: rep_max ?? null,
    rep_user: rep_user ?? null,
    rep_direction: rep_direction ?? null,
    rep_category: rep_category ?? null,
    tdh_min: tdh_min ?? null,
    tdh_max: tdh_max ?? null,
    tdh_inclusion_strategy:
      tdh_inclusion_strategy ?? GroupTdhInclusionStrategy.TDH,
    level_min: level_min ?? null,
    level_max: level_max ?? null,
    owns_meme: owns_meme ?? null,
    owns_meme_tokens: owns_meme_tokens ?? null,
    owns_gradient: owns_gradient ?? null,
    owns_gradient_tokens: owns_gradient_tokens ?? null,
    owns_nextgen: owns_nextgen ?? null,
    owns_nextgen_tokens: owns_nextgen_tokens ?? null,
    owns_lab: owns_lab ?? null,
    owns_lab_tokens: owns_lab_tokens ?? null,
    profile_group_id: profile_group_id ?? null,
    excluded_profile_group_id: excluded_profile_group_id ?? null,
    created_at: Time.millis(0).toDate(),
    created_by: 'a-creator-id',
    visible: true,
    is_private: false,
    is_direct_message: false,
    is_beneficiary_of_grant_id: is_beneficiary_of_grant_id ?? null
  };
}

describe('UserGroupPredicates', () => {
  describe('isRatingOutOfBounds', () => {
    it('should be false when minMaxNullMeansNonZeroRequired=false, mis and max are null and real is zero', () => {
      expect(
        isRatingOutOfBounds({
          min: null,
          max: null,
          real: 0,
          minMaxNullMeansNonZeroRequired: false
        })
      ).toBeFalsy();
    });
    it('should be true when minMaxNullMeansNonZeroRequired=true, mis and max are null and real is zero', () => {
      expect(
        isRatingOutOfBounds({
          min: null,
          max: null,
          real: 0,
          minMaxNullMeansNonZeroRequired: true
        })
      ).toBeTruthy();
    });
    it('should be false when minMaxNullMeansNonZeroRequired=true, mis and max are null and real is not zero', () => {
      expect(
        isRatingOutOfBounds({
          min: null,
          max: null,
          real: 1,
          minMaxNullMeansNonZeroRequired: true
        })
      ).toBeFalsy();
    });
    it('should be false when minMaxNullMeansNonZeroRequired=false, mis and max are null and real is not zero', () => {
      expect(
        isRatingOutOfBounds({
          min: null,
          max: null,
          real: 1,
          minMaxNullMeansNonZeroRequired: false
        })
      ).toBeFalsy();
    });

    it('should be true when min is defined, max is not defined and value is below min', () => {
      expect(
        isRatingOutOfBounds({
          min: 0,
          max: null,
          real: -1,
          minMaxNullMeansNonZeroRequired: false
        })
      ).toBeTruthy();
    });
    it('should be false when min is defined, max is not defined and value is equal to min', () => {
      expect(
        isRatingOutOfBounds({
          min: 0,
          max: null,
          real: 0,
          minMaxNullMeansNonZeroRequired: false
        })
      ).toBeFalsy();
    });
    it('should be false when min is defined, max is not defined and value is above min', () => {
      expect(
        isRatingOutOfBounds({
          min: 0,
          max: null,
          real: 1,
          minMaxNullMeansNonZeroRequired: false
        })
      ).toBeFalsy();
    });

    it('should be true when max is defined, min is not defined and value is above max', () => {
      expect(
        isRatingOutOfBounds({
          min: null,
          max: 0,
          real: 1,
          minMaxNullMeansNonZeroRequired: false
        })
      ).toBeTruthy();
    });
    it('should be false when max is defined, min is not defined and value is equal to max', () => {
      expect(
        isRatingOutOfBounds({
          min: null,
          max: 0,
          real: 0,
          minMaxNullMeansNonZeroRequired: false
        })
      ).toBeFalsy();
    });
    it('should be false when max is defined, min is not defined and value is below max', () => {
      expect(
        isRatingOutOfBounds({
          min: null,
          max: 0,
          real: -1,
          minMaxNullMeansNonZeroRequired: false
        })
      ).toBeFalsy();
    });

    it('should be false when both min and max are defined and value is between them', () => {
      expect(
        isRatingOutOfBounds({
          min: 0,
          max: 2,
          real: 1,
          minMaxNullMeansNonZeroRequired: false
        })
      ).toBeFalsy();
    });
  });

  describe('hasGroupGotOwnsMemeCriteria', () => {
    it('should return true when owns_meme is true', () => {
      expect(hasGroupGotOwnsMemeCriteria(aGroup({ owns_meme: true }))).toBe(
        true
      );
    });
    it('should return false when owns_meme is false', () => {
      expect(hasGroupGotOwnsMemeCriteria(aGroup({ owns_meme: false }))).toBe(
        false
      );
    });
    it('should return false when owns_meme is null', () => {
      expect(hasGroupGotOwnsMemeCriteria(aGroup({ owns_meme: null }))).toBe(
        false
      );
    });
  });

  describe('hasGroupGotOwnsLabCriteria', () => {
    it('should return true when owns_lab is true', () => {
      expect(hasGroupGotOwnsLabCriteria(aGroup({ owns_lab: true }))).toBe(true);
    });
    it('should return false when owns_lab is false', () => {
      expect(hasGroupGotOwnsLabCriteria(aGroup({ owns_lab: false }))).toBe(
        false
      );
    });
    it('should return false when owns_lab is null', () => {
      expect(hasGroupGotOwnsLabCriteria(aGroup({ owns_lab: null }))).toBe(
        false
      );
    });
  });

  describe('hasGroupGotOwnsGradientCriteria', () => {
    it('should return true when owns_gradient is true', () => {
      expect(
        hasGroupGotOwnsGradientCriteria(aGroup({ owns_gradient: true }))
      ).toBe(true);
    });
    it('should return false when owns_gradient is false', () => {
      expect(
        hasGroupGotOwnsGradientCriteria(aGroup({ owns_gradient: false }))
      ).toBe(false);
    });
    it('should return false when owns_gradient is null', () => {
      expect(
        hasGroupGotOwnsGradientCriteria(aGroup({ owns_gradient: null }))
      ).toBe(false);
    });
  });

  describe('hasGroupGotOwnsNextGenCriteria', () => {
    it('should return true when owns_nextgen is true', () => {
      expect(
        hasGroupGotOwnsNextGenCriteria(aGroup({ owns_nextgen: true }))
      ).toBe(true);
    });
    it('should return false when owns_nextgen is false', () => {
      expect(
        hasGroupGotOwnsNextGenCriteria(aGroup({ owns_nextgen: false }))
      ).toBe(false);
    });
    it('should return false when owns_nextgen is null', () => {
      expect(
        hasGroupGotOwnsNextGenCriteria(aGroup({ owns_nextgen: null }))
      ).toBe(false);
    });
  });

  describe('isGroupByOwningsCriteria', () => {
    it('should return true when owns_nextgen is true', () => {
      expect(isGroupByOwningsCriteria(aGroup({ owns_nextgen: true }))).toBe(
        true
      );
    });
    it('should return true when owns_lab is true', () => {
      expect(isGroupByOwningsCriteria(aGroup({ owns_lab: true }))).toBe(true);
    });
    it('should return true when owns_meme is true', () => {
      expect(isGroupByOwningsCriteria(aGroup({ owns_meme: true }))).toBe(true);
    });
    it('should return true when owns_gradient is true', () => {
      expect(isGroupByOwningsCriteria(aGroup({ owns_gradient: true }))).toBe(
        true
      );
    });
    it('should return false when all owns are false', () => {
      expect(isGroupByOwningsCriteria(aGroup({}))).toBe(false);
    });
  });

  describe('isAnyGroupByOwningsCriteria', () => {
    it('should return true when any group has any ownings criteria', () => {
      expect(
        isAnyGroupByOwningsCriteria([
          aGroup({ owns_nextgen: false }),
          aGroup({ owns_nextgen: true })
        ])
      ).toBe(true);
    });
    it('should return false when no group has any ownings criteria', () => {
      expect(
        isAnyGroupByOwningsCriteria([
          aGroup({ owns_nextgen: false }),
          aGroup({ owns_nextgen: false })
        ])
      ).toBe(false);
    });
  });

  describe('isProfileHavingContractTokenOwningsMisMatch', () => {
    it('should return true when profile has none of the tokens by given contract', () => {
      expect(
        isProfileHavingContractTokenOwningsMisMatch({
          neededContract: '0x0',
          neededTokensString: null,
          ownings: {}
        })
      ).toBe(true);
    });
    it('should return false when profile has any tokens of the given contract', () => {
      expect(
        isProfileHavingContractTokenOwningsMisMatch({
          neededContract: '0x0',
          neededTokensString: null,
          ownings: { '0x0': ['one', 'two'], '0x1': ['three'] }
        })
      ).toBe(false);
    });
    it('should return true when profile has got only some of the given tokens', () => {
      expect(
        isProfileHavingContractTokenOwningsMisMatch({
          neededContract: '0x0',
          neededTokensString: '["one", "three"]',
          ownings: { '0x0': ['one', 'two'], '0x1': ['three'] }
        })
      ).toBe(true);
    });
    it('should return false when profile has got all of the required tokens and more', () => {
      expect(
        isProfileHavingContractTokenOwningsMisMatch({
          neededContract: '0x0',
          neededTokensString: '["one", "two"]',
          ownings: { '0x0': ['one', 'two'], '0x1': ['three'] }
        })
      ).toBe(false);
    });
  });

  describe('isProfileViolatingOwnsNextGenCriteria', () => {
    it('should return false when group does not need nextgen', () => {
      expect(
        isProfileViolatingOwnsNextGenCriteria(
          aGroup({ owns_nextgen: false }),
          {}
        )
      ).toBe(false);
    });
    it('should return true when group does need nextgen, but no tokens owned', () => {
      expect(
        isProfileViolatingOwnsNextGenCriteria(
          aGroup({ owns_nextgen: true }),
          {}
        )
      ).toBe(true);
    });
    it('should return false when group does need nextgen, and tokens owned', () => {
      expect(
        isProfileViolatingOwnsNextGenCriteria(aGroup({ owns_nextgen: true }), {
          [NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET].toLowerCase()]: ['one']
        })
      ).toBe(false);
    });
    it('should return true when group does need nextgen, and wrong tokens owned', () => {
      expect(
        isProfileViolatingOwnsNextGenCriteria(
          aGroup({ owns_nextgen: true, owns_nextgen_tokens: '["two"]' }),
          {
            [NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET].toLowerCase()]: ['one']
          }
        )
      ).toBe(true);
    });
    it('should return false when group does need nextgen, and correct tokens owned', () => {
      expect(
        isProfileViolatingOwnsNextGenCriteria(
          aGroup({ owns_nextgen: true, owns_nextgen_tokens: '["two"]' }),
          {
            [NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET].toLowerCase()]: [
              'one',
              'two'
            ]
          }
        )
      ).toBe(false);
    });
  });

  describe('isProfileViolatingGradientCriteria', () => {
    it('should return false when group does not need gradient', () => {
      expect(
        isProfileViolatingGradientCriteria(aGroup({ owns_gradient: false }), {})
      ).toBe(false);
    });
    it('should return true when group does need gradient, but no tokens owned', () => {
      expect(
        isProfileViolatingGradientCriteria(aGroup({ owns_gradient: true }), {})
      ).toBe(true);
    });
    it('should return false when group does need gradient, and tokens owned', () => {
      expect(
        isProfileViolatingGradientCriteria(aGroup({ owns_gradient: true }), {
          [GRADIENT_CONTRACT.toLowerCase()]: ['one']
        })
      ).toBe(false);
    });
    it('should return true when group does need gradient, and wrong tokens owned', () => {
      expect(
        isProfileViolatingGradientCriteria(
          aGroup({ owns_gradient: true, owns_gradient_tokens: '["two"]' }),
          {
            [GRADIENT_CONTRACT.toLowerCase()]: ['one']
          }
        )
      ).toBe(true);
    });
    it('should return false when group does need gradient, and correct tokens owned', () => {
      expect(
        isProfileViolatingGradientCriteria(
          aGroup({ owns_gradient: true, owns_gradient_tokens: '["two"]' }),
          {
            [GRADIENT_CONTRACT.toLowerCase()]: ['one', 'two']
          }
        )
      ).toBe(false);
    });
  });

  describe('isProfileViolatingLabCriteria', () => {
    it('should return false when group does not need lab', () => {
      expect(
        isProfileViolatingLabCriteria(aGroup({ owns_lab: false }), {})
      ).toBe(false);
    });
    it('should return true when group does need lab, but no tokens owned', () => {
      expect(
        isProfileViolatingLabCriteria(aGroup({ owns_lab: true }), {})
      ).toBe(true);
    });
    it('should return false when group does need lab, and tokens owned', () => {
      expect(
        isProfileViolatingLabCriteria(aGroup({ owns_lab: true }), {
          [MEMELAB_CONTRACT.toLowerCase()]: ['one']
        })
      ).toBe(false);
    });
    it('should return true when group does need lab, and wrong tokens owned', () => {
      expect(
        isProfileViolatingLabCriteria(
          aGroup({ owns_lab: true, owns_lab_tokens: '["two"]' }),
          {
            [MEMELAB_CONTRACT.toLowerCase()]: ['one']
          }
        )
      ).toBe(true);
    });
    it('should return false when group does need lab, and correct tokens owned', () => {
      expect(
        isProfileViolatingLabCriteria(
          aGroup({ owns_lab: true, owns_lab_tokens: '["two"]' }),
          {
            [MEMELAB_CONTRACT.toLowerCase()]: ['one', 'two']
          }
        )
      ).toBe(false);
    });
  });

  describe('isProfileViolatingMemesCriteria', () => {
    it('should return false when group does not need meme', () => {
      expect(
        isProfileViolatingMemesCriteria(aGroup({ owns_meme: false }), {})
      ).toBe(false);
    });
    it('should return true when group does need meme, but no tokens owned', () => {
      expect(
        isProfileViolatingMemesCriteria(aGroup({ owns_meme: true }), {})
      ).toBe(true);
    });
    it('should return false when group does need meme, and tokens owned', () => {
      expect(
        isProfileViolatingMemesCriteria(aGroup({ owns_meme: true }), {
          [MEMES_CONTRACT.toLowerCase()]: ['one']
        })
      ).toBe(false);
    });
    it('should return true when group does need meme, and wrong tokens owned', () => {
      expect(
        isProfileViolatingMemesCriteria(
          aGroup({ owns_meme: true, owns_meme_tokens: '["two"]' }),
          {
            [MEMES_CONTRACT.toLowerCase()]: ['one']
          }
        )
      ).toBe(true);
    });
    it('should return false when group does need meme, and correct tokens owned', () => {
      expect(
        isProfileViolatingMemesCriteria(
          aGroup({ owns_meme: true, owns_meme_tokens: '["two"]' }),
          {
            [MEMES_CONTRACT.toLowerCase()]: ['one', 'two']
          }
        )
      ).toBe(false);
    });
  });

  describe('isProfileViolatingOwnsCriteria', () => {
    it('should return true when group violates memes criteria', () => {
      expect(
        isProfileViolatingOwnsCriteria(aGroup({ owns_meme: true }), {})
      ).toBe(true);
    });
    it('should return true when group violates lab criteria', () => {
      expect(
        isProfileViolatingOwnsCriteria(aGroup({ owns_lab: true }), {})
      ).toBe(true);
    });
    it('should return true when group violates nextgen criteria', () => {
      expect(
        isProfileViolatingOwnsCriteria(aGroup({ owns_nextgen: true }), {})
      ).toBe(true);
    });
    it('should return true when group violates gradient criteria', () => {
      expect(
        isProfileViolatingOwnsCriteria(aGroup({ owns_gradient: true }), {})
      ).toBe(true);
    });
    it('should return false when group has no owns criteria', () => {
      expect(isProfileViolatingOwnsCriteria(aGroup({}), {})).toBe(false);
    });
  });

  describe('getUserGroupDirectionOrDefault', () => {
    it('Returns the set direction if it is set', () => {
      expect(getUserGroupDirectionOrDefault(FilterDirection.Received)).toBe(
        FilterDirection.Received
      );
      expect(getUserGroupDirectionOrDefault(FilterDirection.Sent)).toBe(
        FilterDirection.Sent
      );
    });
    it('Returns RECEIVED if direction is not set', () => {
      expect(getUserGroupDirectionOrDefault(null)).toBe(
        FilterDirection.Received
      );
    });
  });

  describe('hasGroupGotTotalSentCicCriteria', () => {
    it('Returns true when Sent and only cic_min is set', () => {
      expect(
        hasGroupGotTotalSentCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_min: 0,
            cic_user: null
          })
        )
      ).toBe(true);
    });
    it('Returns true when Sent and only cic_max is set', () => {
      expect(
        hasGroupGotTotalSentCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_max: 0,
            cic_user: null
          })
        )
      ).toBe(true);
    });
    it('Returns false when Sent and neither cic_min nor cic_max is set', () => {
      expect(
        hasGroupGotTotalSentCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_user: null
          })
        )
      ).toBe(false);
    });
    it('Returns true when Sent and both cic_min and cic_max are set', () => {
      expect(
        hasGroupGotTotalSentCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_user: null,
            cic_min: 0,
            cic_max: 1
          })
        )
      ).toBe(true);
    });
    it('Returns false when Received and both cic_min and cic_max are set', () => {
      expect(
        hasGroupGotTotalSentCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_user: null,
            cic_min: 0,
            cic_max: 1
          })
        )
      ).toBe(false);
    });
    it('Returns false when Sent, both cic_min and cic_max are set and user is also set', () => {
      expect(
        hasGroupGotTotalSentCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_user: 'a-user',
            cic_min: 0,
            cic_max: 1
          })
        )
      ).toBe(false);
    });
  });

  describe('hasGroupGotTotalSentRepCriteria', () => {
    it('Returns true when Sent and only rep_min is set', () => {
      expect(
        hasGroupGotTotalSentRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(true);
    });
    it('Returns true when Sent and only rep_max is set', () => {
      expect(
        hasGroupGotTotalSentRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_max: 0,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(true);
    });
    it('Returns false when Sent and neither rep_min nor rep_max is set', () => {
      expect(
        hasGroupGotTotalSentRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(false);
    });
    it('Returns true when Sent and both rep_min and rep_max are set', () => {
      expect(
        hasGroupGotTotalSentRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_user: null,
            rep_category: null,
            rep_min: 0,
            rep_max: 1
          })
        )
      ).toBe(true);
    });
    it('Returns false when Received and both rep_min and rep_max are set', () => {
      expect(
        hasGroupGotTotalSentRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_user: null,
            rep_category: null,
            rep_min: 0,
            rep_max: 1
          })
        )
      ).toBe(false);
    });
    it('Returns false when Sent, both rep_min and rep_max are set and user is also set', () => {
      expect(
        hasGroupGotTotalSentRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_user: 'a-user',
            rep_category: null,
            rep_min: 0,
            rep_max: 1
          })
        )
      ).toBe(false);
    });
    it('Returns false when Sent, both rep_min and rep_max are set and category is also set', () => {
      expect(
        hasGroupGotTotalSentRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_user: null,
            rep_category: 'category',
            rep_min: 0,
            rep_max: 1
          })
        )
      ).toBe(false);
    });
  });

  describe('hasGroupGotProfileTdhCriteria', () => {
    it('Returns true when min is set', () => {
      expect(
        hasGroupGotProfileTdhCriteria(
          aGroup({
            tdh_min: 0
          })
        )
      ).toBe(true);
    });
    it('Returns true when max is set', () => {
      expect(
        hasGroupGotProfileTdhCriteria(
          aGroup({
            tdh_max: 0
          })
        )
      ).toBe(true);
    });
    it('Returns true when min and max both set', () => {
      expect(
        hasGroupGotProfileTdhCriteria(
          aGroup({
            tdh_min: 0,
            tdh_max: 1
          })
        )
      ).toBe(true);
    });
    it('Returns false when min and max both not set', () => {
      expect(
        hasGroupGotProfileTdhCriteria(
          aGroup({
            tdh_min: null,
            tdh_max: null
          })
        )
      ).toBe(false);
    });
  });

  describe('hasGroupGotProfileLevelCriteria', () => {
    it('Returns true when min is set', () => {
      expect(
        hasGroupGotProfileLevelCriteria(
          aGroup({
            level_min: 0
          })
        )
      ).toBe(true);
    });
    it('Returns true when max is set', () => {
      expect(
        hasGroupGotProfileLevelCriteria(
          aGroup({
            level_max: 0
          })
        )
      ).toBe(true);
    });
    it('Returns true when min and max both set', () => {
      expect(
        hasGroupGotProfileLevelCriteria(
          aGroup({
            level_min: 0,
            level_max: 1
          })
        )
      ).toBe(true);
    });
    it('Returns false when min and max both not set', () => {
      expect(
        hasGroupGotProfileLevelCriteria(
          aGroup({
            level_min: null,
            level_max: null
          })
        )
      ).toBe(false);
    });
  });

  describe('hasGroupGotProfileCicCriteria', () => {
    it('Returns true when Received and only min is set', () => {
      expect(
        hasGroupGotProfileCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_min: 0,
            cic_user: null
          })
        )
      ).toBe(true);
    });
    it('Returns true when Received and only cic_max is set', () => {
      expect(
        hasGroupGotProfileCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_max: 0,
            cic_user: null
          })
        )
      ).toBe(true);
    });
    it('Returns false when Sent and neither cic_min nor cic_max is set', () => {
      expect(
        hasGroupGotProfileCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_user: null
          })
        )
      ).toBe(false);
    });
    it('Returns true when Received and both cic_min and cic_max are set', () => {
      expect(
        hasGroupGotProfileCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_user: null,
            cic_min: 0,
            cic_max: 1
          })
        )
      ).toBe(true);
    });
    it('Returns false when Sent and both cic_min and cic_max are set', () => {
      expect(
        hasGroupGotProfileCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_user: null,
            cic_min: 0,
            cic_max: 1
          })
        )
      ).toBe(false);
    });
    it('Returns false when Received, both cic_min and cic_max are set and user is also set', () => {
      expect(
        hasGroupGotProfileCicCriteria(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_user: 'a-user',
            cic_min: 0,
            cic_max: 1
          })
        )
      ).toBe(false);
    });
  });

  describe('hasGroupGotProfileRepCriteria', () => {
    it('Returns true when Received and only min is set', () => {
      expect(
        hasGroupGotProfileRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(true);
    });
    it('Returns true when Received and only rep_max is set', () => {
      expect(
        hasGroupGotProfileRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_max: 0,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(true);
    });
    it('Returns false when Sent and neither rep_min nor rep_max is set', () => {
      expect(
        hasGroupGotProfileRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(false);
    });
    it('Returns true when Received and both rep_min and rep_max are set', () => {
      expect(
        hasGroupGotProfileRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_user: null,
            rep_category: null,
            rep_min: 0,
            rep_max: 1
          })
        )
      ).toBe(true);
    });
    it('Returns false when Sent and both rep_min and rep_max are set', () => {
      expect(
        hasGroupGotProfileRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_user: null,
            rep_category: null,
            rep_min: 0,
            rep_max: 1
          })
        )
      ).toBe(false);
    });
    it('Returns false when Received, both rep_min and rep_max are set and user is also set', () => {
      expect(
        hasGroupGotProfileRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_user: 'a-user',
            rep_category: null,
            rep_min: 0,
            rep_max: 1
          })
        )
      ).toBe(false);
    });
    it('Returns false when Received, both rep_min and rep_max are set and category is also set', () => {
      expect(
        hasGroupGotProfileRepCriteria(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_user: null,
            rep_category: 'a-category',
            rep_min: 0,
            rep_max: 1
          })
        )
      ).toBe(false);
    });
  });

  describe('isGroupTotalCicByUserOutgoing', () => {
    it('Returns true when Sent and user and min is set', () => {
      expect(
        isGroupTotalCicByUserOutgoing(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_min: 0,
            cic_user: 'a-user'
          })
        )
      ).toBe(true);
    });
    it('Returns true when Sent and user and max is set', () => {
      expect(
        isGroupTotalCicByUserOutgoing(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_max: 0,
            cic_user: 'a-user'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Received and user and max is set', () => {
      expect(
        isGroupTotalCicByUserOutgoing(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_max: 0,
            cic_user: 'a-user'
          })
        )
      ).toBe(false);
    });

    it('Returns true when Sent and user and min and max is set', () => {
      expect(
        isGroupTotalCicByUserOutgoing(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_min: 0,
            cic_max: 1,
            cic_user: 'a-user'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Sent and min and max is set, but user is not', () => {
      expect(
        isGroupTotalCicByUserOutgoing(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_min: 0,
            cic_max: 1,
            cic_user: null
          })
        )
      ).toBe(false);
    });
  });

  describe('isGroupTotalCicByUserIncoming', () => {
    it('Returns true when Received and user and min is set', () => {
      expect(
        isGroupTotalCicByUserIncoming(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_min: 0,
            cic_user: 'a-user'
          })
        )
      ).toBe(true);
    });
    it('Returns true when Received and user and max is set', () => {
      expect(
        isGroupTotalCicByUserIncoming(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_max: 0,
            cic_user: 'a-user'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Sent and user and max is set', () => {
      expect(
        isGroupTotalCicByUserIncoming(
          aGroup({
            cic_direction: FilterDirection.Sent,
            cic_max: 0,
            cic_user: 'a-user'
          })
        )
      ).toBe(false);
    });

    it('Returns true when Received and user and min and max is set', () => {
      expect(
        isGroupTotalCicByUserIncoming(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_min: 0,
            cic_max: 1,
            cic_user: 'a-user'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Received and min and max is set, but user is not', () => {
      expect(
        isGroupTotalCicByUserIncoming(
          aGroup({
            cic_direction: FilterDirection.Received,
            cic_min: 0,
            cic_max: 1,
            cic_user: null
          })
        )
      ).toBe(false);
    });
  });

  describe('isGroupTotalRepByUserOutgoing', () => {
    it('Returns true when Sent and user and min is set', () => {
      expect(
        isGroupTotalRepByUserOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(true);
    });
    it('Returns true when Sent and user and max is set', () => {
      expect(
        isGroupTotalRepByUserOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_max: 0,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(true);
    });

    it('Returns false when Received and user and max is set', () => {
      expect(
        isGroupTotalRepByUserOutgoing(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_max: 0,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(false);
    });

    it('Returns true when Sent and user and min and max is set', () => {
      expect(
        isGroupTotalRepByUserOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(true);
    });

    it('Returns false when Sent and min and max is set, but user is not', () => {
      expect(
        isGroupTotalRepByUserOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(false);
    });

    it('Returns false when Sent and min and max and user and category is set', () => {
      expect(
        isGroupTotalRepByUserOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });
  });

  describe('isGroupTotalRepByUserIncoming', () => {
    it('Returns true when Received and user and min is set', () => {
      expect(
        isGroupTotalRepByUserIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(true);
    });
    it('Returns true when Received and user and max is set', () => {
      expect(
        isGroupTotalRepByUserIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_max: 0,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(true);
    });

    it('Returns false when Sent and user and max is set', () => {
      expect(
        isGroupTotalRepByUserIncoming(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_max: 0,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(false);
    });

    it('Returns true when Received and user and min and max is set', () => {
      expect(
        isGroupTotalRepByUserIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(true);
    });

    it('Returns false when Received and min and max is set, but user is not', () => {
      expect(
        isGroupTotalRepByUserIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(false);
    });

    it('Returns false when Received and min and max and user and category is set', () => {
      expect(
        isGroupTotalRepByUserIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });
  });

  describe('isGroupTotalRepForCategoryOutgoing', () => {
    it('Returns true when Sent and category and min is set', () => {
      expect(
        isGroupTotalRepForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });
    it('Returns true when Sent and category and max is set', () => {
      expect(
        isGroupTotalRepForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_max: 0,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Received and category and max is set', () => {
      expect(
        isGroupTotalRepForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_max: 0,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });

    it('Returns true when Sent and category and min and max is set', () => {
      expect(
        isGroupTotalRepForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Sent and min and max is set, but user is not', () => {
      expect(
        isGroupTotalRepForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(false);
    });

    it('Returns false when Sent and min and max and category and user is set', () => {
      expect(
        isGroupTotalRepForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });
  });

  describe('isGroupTotalRepByCategoryIncoming', () => {
    it('Returns true when Received and category and min is set', () => {
      expect(
        isGroupTotalRepForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });
    it('Returns true when Received and category and max is set', () => {
      expect(
        isGroupTotalRepForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_max: 0,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Sent and category and max is set', () => {
      expect(
        isGroupTotalRepForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_max: 0,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });

    it('Returns true when Received and category and min and max is set', () => {
      expect(
        isGroupTotalRepForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Received and min and max is set, but user is not', () => {
      expect(
        isGroupTotalRepForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(false);
    });

    it('Returns false when Received and min and max and category and user is set', () => {
      expect(
        isGroupTotalRepForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });
  });

  // -----

  describe('isGroupTotalRepByUserForCategoryOutgoing', () => {
    it('Returns true when Sent and category and user and min is set', () => {
      expect(
        isGroupTotalRepByUserForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });
    it('Returns true when Sent and category and user and max is set', () => {
      expect(
        isGroupTotalRepByUserForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_max: 0,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Received and category and user and max is set', () => {
      expect(
        isGroupTotalRepByUserForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_max: 0,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });

    it('Returns true when Sent and category and user and min and max is set', () => {
      expect(
        isGroupTotalRepByUserForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Sent and min and max and user is set, but category is not', () => {
      expect(
        isGroupTotalRepByUserForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(false);
    });

    it('Returns false when Sent and min and max and category is set, but user is not', () => {
      expect(
        isGroupTotalRepByUserForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });

    it('Returns false when Sent and min and max are set but category and user are not', () => {
      expect(
        isGroupTotalRepByUserForCategoryOutgoing(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(false);
    });
  });

  describe('isGroupTotalRepByUserForCategoryIncoming', () => {
    it('Returns true when Received and category and min is set', () => {
      expect(
        isGroupTotalRepByUserForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });
    it('Returns true when Received and category and max is set', () => {
      expect(
        isGroupTotalRepByUserForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_max: 0,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Sent and category and max is set', () => {
      expect(
        isGroupTotalRepByUserForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Sent,
            rep_max: 0,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });

    it('Returns true when Received and category and min and max is set', () => {
      expect(
        isGroupTotalRepByUserForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: 'a-category'
          })
        )
      ).toBe(true);
    });

    it('Returns false when Received and min and max is set, but user and category are not', () => {
      expect(
        isGroupTotalRepByUserForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: null
          })
        )
      ).toBe(false);
    });

    it('Returns false when Received and min and max and user is set but category is not', () => {
      expect(
        isGroupTotalRepByUserForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: 'a-user',
            rep_category: null
          })
        )
      ).toBe(false);
    });

    it('Returns false when Received and min and max and category is set but user is not', () => {
      expect(
        isGroupTotalRepByUserForCategoryIncoming(
          aGroup({
            rep_direction: FilterDirection.Received,
            rep_min: 0,
            rep_max: 1,
            rep_user: null,
            rep_category: 'a-category'
          })
        )
      ).toBe(false);
    });
  });

  describe('isGroupViolatingAnySpecificCicCriteria', () => {
    it('should return false on no criteria', () => {
      expect(isGroupViolatingAnySpecificCicCriteria(aGroup({}), [], [])).toBe(
        false
      );
    });
    it('should check outgoing user cic criteria', () => {
      expect(
        isGroupViolatingAnySpecificCicCriteria(
          aGroup({ cic_user: 'a-user', cic_direction: FilterDirection.Sent }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            }
          ],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'REP',
              rating: 1
            },
            {
              other_side_id: 'another-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            }
          ]
        )
      ).toBe(true);
      expect(
        isGroupViolatingAnySpecificCicCriteria(
          aGroup({ cic_user: 'a-user', cic_direction: FilterDirection.Sent }),
          [],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            }
          ]
        )
      ).toBe(false);
    });

    it('should check incoming user cic criteria', () => {
      expect(
        isGroupViolatingAnySpecificCicCriteria(
          aGroup({
            cic_user: 'a-user',
            cic_direction: FilterDirection.Received
          }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'REP',
              rating: 1
            },
            {
              other_side_id: 'another-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            }
          ],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            }
          ]
        )
      ).toBe(true);
      expect(
        isGroupViolatingAnySpecificCicCriteria(
          aGroup({
            cic_user: 'a-user',
            cic_direction: FilterDirection.Received
          }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            }
          ],
          []
        )
      ).toBe(false);
    });
  });

  describe('isGroupViolatingAnySpecificRepCriteria', () => {
    it('should return false on no criteria', () => {
      expect(isGroupViolatingAnySpecificRepCriteria(aGroup({}), [], [])).toBe(
        false
      );
    });
    it('should check outgoing user rep criteria', () => {
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({ rep_user: 'a-user', rep_direction: FilterDirection.Sent }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'REP',
              rating: 1
            }
          ],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            },
            {
              other_side_id: 'another-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            }
          ]
        )
      ).toBe(true);
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({ rep_user: 'a-user', rep_direction: FilterDirection.Sent }),
          [],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'REP',
              rating: 1
            }
          ]
        )
      ).toBe(false);
    });

    it('should check incoming user rep criteria', () => {
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_user: 'a-user',
            rep_direction: FilterDirection.Received
          }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            },
            {
              other_side_id: 'another-user',
              matter: RateMatter.REP,
              matter_category: 'REP',
              rating: 1
            }
          ],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'REP',
              rating: 1
            }
          ]
        )
      ).toBe(true);
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_user: 'a-user',
            rep_direction: FilterDirection.Received
          }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'REP',
              rating: 1
            }
          ],
          []
        )
      ).toBe(false);
    });

    it('should check incoming category rep criteria', () => {
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_category: 'a-category',
            rep_direction: FilterDirection.Received,
            rep_min: 1
          }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            },
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'another-category',
              rating: 1
            }
          ],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ]
        )
      ).toBe(true);
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_category: 'a-category',
            rep_direction: FilterDirection.Received,
            rep_min: 1
          }),
          [
            {
              other_side_id: 'another-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ],
          []
        )
      ).toBe(false);
    });
    it('should check outgoing category rep criteria', () => {
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_category: 'a-category',
            rep_direction: FilterDirection.Sent,
            rep_min: 1
          }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            },
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'another-category',
              rating: 1
            }
          ]
        )
      ).toBe(true);
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_category: 'a-category',
            rep_direction: FilterDirection.Sent,
            rep_min: 1
          }),
          [],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ]
        )
      ).toBe(false);
    });

    it('should check incoming category user-rep criteria', () => {
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_category: 'a-category',
            rep_user: 'a-user',
            rep_direction: FilterDirection.Received,
            rep_min: 1
          }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            },
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'another-category',
              rating: 1
            },
            {
              other_side_id: 'another-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ]
        )
      ).toBe(true);
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_category: 'a-category',
            rep_direction: FilterDirection.Received,
            rep_min: 1
          }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ],
          []
        )
      ).toBe(false);
    });
    it('should check outgoing category user-rep criteria', () => {
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_category: 'a-category',
            rep_user: 'a-user',
            rep_direction: FilterDirection.Sent,
            rep_min: 1
          }),
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.CIC,
              matter_category: 'CIC',
              rating: 1
            },
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'another-category',
              rating: 1
            },
            {
              other_side_id: 'another-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ]
        )
      ).toBe(true);
      expect(
        isGroupViolatingAnySpecificRepCriteria(
          aGroup({
            rep_category: 'a-category',
            rep_direction: FilterDirection.Sent,
            rep_min: 1
          }),
          [],
          [
            {
              other_side_id: 'a-user',
              matter: RateMatter.REP,
              matter_category: 'a-category',
              rating: 1
            }
          ]
        )
      ).toBe(false);
    });
  });

  describe('hasGroupGotAnyNonIdentityConditions', () => {
    it('no non-identity conditions', () => {
      expect(hasGroupGotAnyNonIdentityConditions(aGroup({}))).toBe(false);
    });
    it('ownings condition', () => {
      expect(
        hasGroupGotAnyNonIdentityConditions(aGroup({ owns_meme: true }))
      ).toBe(true);
    });
    it('tdh min condition', () => {
      expect(hasGroupGotAnyNonIdentityConditions(aGroup({ tdh_min: 1 }))).toBe(
        true
      );
    });
    it('tdh max condition', () => {
      expect(hasGroupGotAnyNonIdentityConditions(aGroup({ tdh_max: 1 }))).toBe(
        true
      );
    });
    it('level min condition', () => {
      expect(
        hasGroupGotAnyNonIdentityConditions(aGroup({ level_min: 1 }))
      ).toBe(true);
    });
    it('level max condition', () => {
      expect(
        hasGroupGotAnyNonIdentityConditions(aGroup({ level_max: 1 }))
      ).toBe(true);
    });
    it('rep min condition', () => {
      expect(hasGroupGotAnyNonIdentityConditions(aGroup({ rep_min: 1 }))).toBe(
        true
      );
    });
    it('rep max condition', () => {
      expect(hasGroupGotAnyNonIdentityConditions(aGroup({ rep_max: 1 }))).toBe(
        true
      );
    });
    it('rep user condition', () => {
      expect(
        hasGroupGotAnyNonIdentityConditions(aGroup({ rep_user: 'a-user' }))
      ).toBe(true);
    });
    it('rep category condition', () => {
      expect(
        hasGroupGotAnyNonIdentityConditions(
          aGroup({ rep_category: 'a-category' })
        )
      ).toBe(true);
    });
    it('cic min condition', () => {
      expect(hasGroupGotAnyNonIdentityConditions(aGroup({ cic_min: 1 }))).toBe(
        true
      );
    });
    it('cic max condition', () => {
      expect(hasGroupGotAnyNonIdentityConditions(aGroup({ cic_max: 1 }))).toBe(
        true
      );
    });
    it('cic user condition', () => {
      expect(
        hasGroupGotAnyNonIdentityConditions(aGroup({ cic_user: 'a-user' }))
      ).toBe(true);
    });
    it('beneficiary grant condition', () => {
      expect(
        hasGroupGotAnyNonIdentityConditions(
          aGroup({ is_beneficiary_of_grant_id: 'an_id' })
        )
      ).toBe(true);
    });
  });

  describe('isProfileViolatingGroupsProfileTdhCriteria', () => {
    it('no condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileTdhCriteria(aProfile({}), aGroup({}))
      ).toBe(false);
    });
    it('condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileTdhCriteria(
          aProfile({ tdh: 5 }),
          aGroup({ tdh_min: 5, tdh_max: 5 })
        )
      ).toBe(false);
    });
    it('condition - violating', () => {
      expect(
        isProfileViolatingGroupsProfileTdhCriteria(
          aProfile({ tdh: 4 }),
          aGroup({ tdh_min: 5, tdh_max: 5 })
        )
      ).toBe(true);
    });
    it('xtdh does not count', () => {
      expect(
        isProfileViolatingGroupsProfileTdhCriteria(
          aProfile({ xtdh: 5 }),
          aGroup({
            tdh_min: 5,
            tdh_max: 5,
            tdh_inclusion_strategy: GroupTdhInclusionStrategy.TDH
          })
        )
      ).toBe(true);
    });
  });

  describe('isProfileViolatingGroupsProfileTdhCriteria_XTDH', () => {
    it('condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileTdhCriteria(
          aProfile({ xtdh: 5 }),
          aGroup({
            tdh_min: 5,
            tdh_max: 5,
            tdh_inclusion_strategy: GroupTdhInclusionStrategy.XTDH
          })
        )
      ).toBe(false);
    });
    it('condition - violating', () => {
      expect(
        isProfileViolatingGroupsProfileTdhCriteria(
          aProfile({ xtdh: 4 }),
          aGroup({
            tdh_min: 5,
            tdh_max: 5,
            tdh_inclusion_strategy: GroupTdhInclusionStrategy.XTDH
          })
        )
      ).toBe(true);
    });
    it('tdh does not count', () => {
      expect(
        isProfileViolatingGroupsProfileTdhCriteria(
          aProfile({ tdh: 5 }),
          aGroup({
            tdh_min: 5,
            tdh_max: 5,
            tdh_inclusion_strategy: GroupTdhInclusionStrategy.XTDH
          })
        )
      ).toBe(true);
    });
  });

  describe('isProfileViolatingGroupsProfileTdhCriteria_BOTH', () => {
    it('condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileTdhCriteria(
          aProfile({ xtdh: 3, tdh: 2 }),
          aGroup({
            tdh_min: 5,
            tdh_max: 5,
            tdh_inclusion_strategy: GroupTdhInclusionStrategy.BOTH
          })
        )
      ).toBe(false);
    });
    it('condition - violating', () => {
      expect(
        isProfileViolatingGroupsProfileTdhCriteria(
          aProfile({ xtdh: 2, tdh: 2 }),
          aGroup({
            tdh_min: 5,
            tdh_max: 5,
            tdh_inclusion_strategy: GroupTdhInclusionStrategy.BOTH
          })
        )
      ).toBe(true);
    });
  });

  describe('isProfileViolatingGroupsProfileLevelCriteria', () => {
    it('no condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileLevelCriteria(aProfile({}), aGroup({}))
      ).toBe(false);
    });
    it('condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileLevelCriteria(
          aProfile({ level: 5 }),
          aGroup({ level_min: 5, level_max: 5 })
        )
      ).toBe(false);
    });
    it('condition - violating', () => {
      expect(
        isProfileViolatingGroupsProfileLevelCriteria(
          aProfile({ level: 4 }),
          aGroup({ level_min: 5, level_max: 5 })
        )
      ).toBe(true);
    });
  });

  describe('isProfileViolatingGroupsProfileRepCriteria', () => {
    it('no condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileRepCriteria(aProfile({}), aGroup({}))
      ).toBe(false);
    });
    it('condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileRepCriteria(
          aProfile({ rep: 5 }),
          aGroup({ rep_min: 5, rep_max: 5 })
        )
      ).toBe(false);
    });
    it('condition - violating', () => {
      expect(
        isProfileViolatingGroupsProfileRepCriteria(
          aProfile({ rep: 4 }),
          aGroup({ rep_min: 5, rep_max: 5 })
        )
      ).toBe(true);
    });
  });

  describe('isProfileViolatingGroupsProfileCicCriteria', () => {
    it('no condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileCicCriteria(aProfile({}), aGroup({}))
      ).toBe(false);
    });
    it('condition - not violating', () => {
      expect(
        isProfileViolatingGroupsProfileCicCriteria(
          aProfile({ cic: 5 }),
          aGroup({ cic_min: 5, cic_max: 5 })
        )
      ).toBe(false);
    });
    it('condition - violating', () => {
      expect(
        isProfileViolatingGroupsProfileCicCriteria(
          aProfile({ cic: 4 }),
          aGroup({ cic_min: 5, cic_max: 5 })
        )
      ).toBe(true);
    });
  });

  describe('isProfileViolatingTotalSentRepCriteria', () => {
    it('no condition - not violating', () => {
      expect(isProfileViolatingTotalSentRepCriteria(0, aGroup({}))).toBe(false);
    });
    it('condition - not violating', () => {
      expect(
        isProfileViolatingTotalSentRepCriteria(
          5,
          aGroup({
            rep_min: 5,
            rep_direction: FilterDirection.Sent,
            rep_max: 5
          })
        )
      ).toBe(false);
    });
    it('condition - violating', () => {
      expect(
        isProfileViolatingTotalSentRepCriteria(
          4,
          aGroup({
            rep_min: 5,
            rep_direction: FilterDirection.Sent,
            rep_max: 5
          })
        )
      ).toBe(true);
    });
  });

  describe('isProfileViolatingTotalSentCicCriteria', () => {
    it('no condition - not violating', () => {
      expect(isProfileViolatingTotalSentCicCriteria(0, aGroup({}))).toBe(false);
    });
    it('condition - not violating', () => {
      expect(
        isProfileViolatingTotalSentCicCriteria(
          5,
          aGroup({
            cic_min: 5,
            cic_direction: FilterDirection.Sent,
            cic_max: 5
          })
        )
      ).toBe(false);
    });
    it('condition - violating', () => {
      expect(
        isProfileViolatingTotalSentCicCriteria(
          4,
          aGroup({
            cic_min: 5,
            cic_direction: FilterDirection.Sent,
            cic_max: 5
          })
        )
      ).toBe(true);
    });
  });

  describe('isAnyGroupByTotalSentCicOrRepCriteria', () => {
    it('there are some', () => {
      expect(
        isAnyGroupByTotalSentCicOrRepCriteria([
          aGroup({ cic_direction: FilterDirection.Sent, cic_min: 5 })
        ])
      ).toBe(true);
      expect(
        isAnyGroupByTotalSentCicOrRepCriteria([
          aGroup({ rep_direction: FilterDirection.Sent, rep_max: 5 })
        ])
      ).toBe(true);
    });

    it('there are none', () => {
      expect(
        isAnyGroupByTotalSentCicOrRepCriteria([
          aGroup({ cic_direction: FilterDirection.Received, cic_min: 5 })
        ])
      ).toBe(false);
      expect(
        isAnyGroupByTotalSentCicOrRepCriteria([
          aGroup({ rep_direction: FilterDirection.Received, rep_max: 5 })
        ])
      ).toBe(false);
    });
  });
});
