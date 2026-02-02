import {
  FilterDirection,
  GroupTdhInclusionStrategy,
  UserGroupEntity
} from '../entities/IUserGroup';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { RateMatter } from '../entities/IRating';
import { NEXTGEN_CORE_CONTRACT } from '../nextgen/nextgen_constants';
import { Network } from 'alchemy-sdk';
import { numbers } from '../numbers';
import { assertUnreachable } from '../assertions';

export const isRatingOutOfBounds = ({
  min,
  max,
  real,
  minMaxNullMeansNonZeroRequired
}: {
  min: number | null;
  max: number | null;
  real: number;
  minMaxNullMeansNonZeroRequired: boolean;
}) => {
  if (
    minMaxNullMeansNonZeroRequired &&
    min === null &&
    max === null &&
    real === 0
  ) {
    return true;
  }

  const inBounds =
    (min === null || real >= min) && (max === null || real <= max);
  return !inBounds;
};

export const hasGroupGotOwnsMemeCriteria = (entity: UserGroupEntity) => {
  return !!entity.owns_meme;
};

export const hasGroupGotOwnsLabCriteria = (entity: UserGroupEntity) => {
  return !!entity.owns_lab;
};

export const hasGroupGotOwnsGradientCriteria = (entity: UserGroupEntity) => {
  return !!entity.owns_gradient;
};

export const hasGroupGotOwnsNextGenCriteria = (entity: UserGroupEntity) => {
  return !!entity.owns_nextgen;
};

export const isGroupByOwningsCriteria = (entity: UserGroupEntity) => {
  return (
    hasGroupGotOwnsGradientCriteria(entity) ||
    hasGroupGotOwnsMemeCriteria(entity) ||
    hasGroupGotOwnsLabCriteria(entity) ||
    hasGroupGotOwnsNextGenCriteria(entity)
  );
};

export const isAnyGroupByOwningsCriteria = (groups: UserGroupEntity[]) => {
  return !!groups.find((it) => isGroupByOwningsCriteria(it));
};

export const isProfileHavingContractTokenOwningsMisMatch = ({
  neededContract,
  neededTokensString,
  ownings
}: {
  neededContract: string;
  neededTokensString: string | null;
  ownings: Record<string, string[]>;
}): boolean => {
  const profilesCollectionOwnings = ownings[neededContract.toLowerCase()] ?? [];
  if (profilesCollectionOwnings.length === 0) {
    return true;
  }
  const neededTokens = (
    neededTokensString ? JSON.parse(neededTokensString) : []
  ) as string[];
  return (
    neededTokens.length !== 0 &&
    !!neededTokens.find((it) => !profilesCollectionOwnings.includes(it))
  );
};

export const isProfileViolatingOwnsNextGenCriteria = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
): boolean => {
  return (
    hasGroupGotOwnsNextGenCriteria(entity) &&
    isProfileHavingContractTokenOwningsMisMatch({
      neededContract: NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET],
      neededTokensString: entity.owns_nextgen_tokens,
      ownings
    })
  );
};

export const isProfileViolatingGradientCriteria = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
): boolean => {
  return (
    hasGroupGotOwnsGradientCriteria(entity) &&
    isProfileHavingContractTokenOwningsMisMatch({
      neededContract: GRADIENT_CONTRACT,
      neededTokensString: entity.owns_gradient_tokens,
      ownings
    })
  );
};

export const isProfileViolatingLabCriteria = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
): boolean => {
  return (
    hasGroupGotOwnsLabCriteria(entity) &&
    isProfileHavingContractTokenOwningsMisMatch({
      neededContract: MEMELAB_CONTRACT,
      neededTokensString: entity.owns_lab_tokens,
      ownings
    })
  );
};

export const isProfileViolatingMemesCriteria = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
) => {
  return (
    hasGroupGotOwnsMemeCriteria(entity) &&
    isProfileHavingContractTokenOwningsMisMatch({
      neededContract: MEMES_CONTRACT,
      neededTokensString: entity.owns_meme_tokens,
      ownings
    })
  );
};

export const isProfileViolatingOwnsCriteria = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
) => {
  return (
    isProfileViolatingOwnsNextGenCriteria(entity, ownings) ||
    isProfileViolatingGradientCriteria(entity, ownings) ||
    isProfileViolatingLabCriteria(entity, ownings) ||
    isProfileViolatingMemesCriteria(entity, ownings)
  );
};

export const getUserGroupDirectionOrDefault = (
  direction: FilterDirection | null
) => direction ?? FilterDirection.Received;

export const hasGroupGotTotalSentCicCriteria = (entity: UserGroupEntity) => {
  return (
    (entity.cic_min !== null || entity.cic_max !== null) &&
    entity.cic_user === null &&
    getUserGroupDirectionOrDefault(entity.cic_direction) ===
      FilterDirection.Sent
  );
};

export const hasGroupGotTotalSentRepCriteria = (entity: UserGroupEntity) => {
  return (
    (entity.rep_min !== null || entity.rep_max !== null) &&
    entity.rep_user === null &&
    entity.rep_category === null &&
    getUserGroupDirectionOrDefault(entity.rep_direction) ===
      FilterDirection.Sent
  );
};

export const hasGroupGotProfileTdhCriteria = (entity: UserGroupEntity) => {
  return entity.tdh_min !== null || entity.tdh_max !== null;
};

export const hasGroupGotProfileLevelCriteria = (entity: UserGroupEntity) => {
  return entity.level_min !== null || entity.level_max !== null;
};

export const hasGroupGotProfileCicCriteria = (entity: UserGroupEntity) => {
  return (
    (entity.cic_min !== null || entity.cic_max !== null) &&
    entity.cic_user === null &&
    getUserGroupDirectionOrDefault(entity.cic_direction) ===
      FilterDirection.Received
  );
};

export const hasGroupGotProfileRepCriteria = (entity: UserGroupEntity) => {
  return (
    (entity.rep_min !== null || entity.rep_max !== null) &&
    entity.rep_user === null &&
    entity.rep_category === null &&
    getUserGroupDirectionOrDefault(entity.rep_direction) ===
      FilterDirection.Received
  );
};

export const isGroupTotalCicByUserOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.cic_user !== null &&
    getUserGroupDirectionOrDefault(entity.cic_direction) ===
      FilterDirection.Sent
  );
};

export const isGroupTotalCicByUserIncoming = (entity: UserGroupEntity) => {
  return (
    entity.cic_user !== null &&
    getUserGroupDirectionOrDefault(entity.cic_direction) ===
      FilterDirection.Received
  );
};

export const isGroupTotalRepByUserOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.rep_category === null &&
    entity.rep_user !== null &&
    getUserGroupDirectionOrDefault(entity.rep_direction) ===
      FilterDirection.Sent
  );
};

export const isGroupTotalRepByUserIncoming = (entity: UserGroupEntity) => {
  return (
    entity.rep_category === null &&
    entity.rep_user !== null &&
    getUserGroupDirectionOrDefault(entity.rep_direction) ===
      FilterDirection.Received
  );
};

export const isGroupTotalRepForCategoryOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user === null &&
    getUserGroupDirectionOrDefault(entity.rep_direction) ===
      FilterDirection.Sent
  );
};

export const isGroupTotalRepForCategoryIncoming = (entity: UserGroupEntity) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user === null &&
    getUserGroupDirectionOrDefault(entity.rep_direction) ===
      FilterDirection.Received
  );
};

export const isGroupTotalRepByUserForCategoryOutgoing = (
  entity: UserGroupEntity
) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user !== null &&
    getUserGroupDirectionOrDefault(entity.rep_direction) ===
      FilterDirection.Sent
  );
};

export const isGroupTotalRepByUserForCategoryIncoming = (
  entity: UserGroupEntity
) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user !== null &&
    getUserGroupDirectionOrDefault(entity.rep_direction) ===
      FilterDirection.Received
  );
};

function isRealRatingOutOfBounds(
  ratings: {
    other_side_id: string;
    matter: RateMatter;
    matter_category: string;
    rating: number;
  }[],
  sumCriteria: (
    rating: {
      other_side_id: string;
      matter: RateMatter;
      matter_category: string;
      rating: number;
    },
    group: UserGroupEntity
  ) => boolean,
  group: UserGroupEntity,
  min: number | null,
  max: number | null
) {
  const real = numbers.sum(
    ratings.filter((it) => sumCriteria(it, group)).map((it) => it.rating)
  );
  return isRatingOutOfBounds({
    min,
    max,
    real,
    minMaxNullMeansNonZeroRequired: true
  });
}

export const isGroupViolatingAnySpecificRepCriteria = (
  group: UserGroupEntity,
  incomingRatings: {
    other_side_id: string;
    matter: RateMatter;
    matter_category: string;
    rating: number;
  }[],
  outgoingRatings: {
    other_side_id: string;
    matter: RateMatter;
    matter_category: string;
    rating: number;
  }[]
): boolean => {
  const violatingTotalRepByUserIncoming =
    isGroupTotalRepByUserIncoming(group) &&
    isRealRatingOutOfBounds(
      incomingRatings,
      (r, g) => r.matter === RateMatter.REP && r.other_side_id === g.rep_user,
      group,
      group.rep_min,
      group.rep_max
    );
  const violatingTotalRepByUserOutgoing =
    isGroupTotalRepByUserOutgoing(group) &&
    isRealRatingOutOfBounds(
      outgoingRatings,
      (r, g) => r.matter === RateMatter.REP && r.other_side_id === g.rep_user,
      group,
      group.rep_min,
      group.rep_max
    );
  const violatingTotalRepForCategoryIncoming =
    isGroupTotalRepForCategoryIncoming(group) &&
    isRealRatingOutOfBounds(
      incomingRatings,
      (r, g) =>
        r.matter === RateMatter.REP && r.matter_category === g.rep_category,
      group,
      group.rep_min,
      group.rep_max
    );
  const violatingTotalRepForCategoryOutgoing =
    isGroupTotalRepForCategoryOutgoing(group) &&
    isRealRatingOutOfBounds(
      outgoingRatings,
      (r, g) =>
        r.matter === RateMatter.REP && r.matter_category === g.rep_category,
      group,
      group.rep_min,
      group.rep_max
    );
  const violatingTotalRepByUserForCategoryIncoming =
    isGroupTotalRepByUserForCategoryIncoming(group) &&
    isRealRatingOutOfBounds(
      incomingRatings,
      (r, g) =>
        r.matter === RateMatter.REP &&
        r.matter_category === g.rep_category &&
        r.other_side_id === g.rep_user,
      group,
      group.rep_min,
      group.rep_max
    );
  const violatingTotalRepByUserForCategoryOutgoing =
    isGroupTotalRepByUserForCategoryOutgoing(group) &&
    isRealRatingOutOfBounds(
      outgoingRatings,
      (r, g) =>
        r.matter === RateMatter.REP &&
        r.matter_category === g.rep_category &&
        r.other_side_id === g.rep_user,
      group,
      group.rep_min,
      group.rep_max
    );
  return (
    violatingTotalRepByUserIncoming ||
    violatingTotalRepByUserOutgoing ||
    violatingTotalRepForCategoryIncoming ||
    violatingTotalRepForCategoryOutgoing ||
    violatingTotalRepByUserForCategoryIncoming ||
    violatingTotalRepByUserForCategoryOutgoing
  );
};

export const isGroupViolatingAnySpecificCicCriteria = (
  group: UserGroupEntity,
  incomingRatings: {
    other_side_id: string;
    matter: RateMatter;
    matter_category: string;
    rating: number;
  }[],
  outgoingRatings: {
    other_side_id: string;
    matter: RateMatter;
    matter_category: string;
    rating: number;
  }[]
): boolean => {
  const violatingTotalCicByUserIncoming =
    isGroupTotalCicByUserIncoming(group) &&
    isRealRatingOutOfBounds(
      incomingRatings,
      (r, g) => r.matter === RateMatter.CIC && r.other_side_id === g.cic_user,
      group,
      group.cic_min,
      group.cic_max
    );
  const violatingTotalCicByUserOutgoing =
    isGroupTotalCicByUserOutgoing(group) &&
    isRealRatingOutOfBounds(
      outgoingRatings,
      (r, g) => r.matter === RateMatter.CIC && r.other_side_id === g.cic_user,
      group,
      group.cic_min,
      group.cic_max
    );
  return violatingTotalCicByUserIncoming || violatingTotalCicByUserOutgoing;
};

export const hasGroupGotAnyNonIdentityConditions = (
  entity: UserGroupEntity
) => {
  return (
    isGroupByOwningsCriteria(entity) ||
    hasGroupGotProfileTdhCriteria(entity) ||
    hasGroupGotProfileLevelCriteria(entity) ||
    entity.rep_min !== null ||
    entity.rep_max !== null ||
    entity.cic_min !== null ||
    entity.cic_max !== null ||
    entity.cic_user !== null ||
    entity.rep_user !== null ||
    entity.rep_category !== null ||
    entity.is_beneficiary_of_grant_id !== null
  );
};

export const isProfileViolatingGroupsProfileTdhCriteria = (
  profile: ProfileSimpleMetrics,
  entity: UserGroupEntity
) => {
  return (
    hasGroupGotProfileTdhCriteria(entity) &&
    isProfileTdhOutOfGroupsBounds(profile, entity)
  );
};

export const isProfileViolatingGroupsProfileLevelCriteria = (
  profile: ProfileSimpleMetrics,
  entity: UserGroupEntity
) => {
  return (
    hasGroupGotProfileLevelCriteria(entity) &&
    isProfileLevelOutOfGroupsBounds(profile, entity)
  );
};

export const isProfileViolatingGroupsProfileRepCriteria = (
  profile: ProfileSimpleMetrics,
  entity: UserGroupEntity
) => {
  return (
    hasGroupGotProfileRepCriteria(entity) &&
    isProfileRepOutOfGroupsBounds(profile, entity)
  );
};

export const isProfileViolatingGroupsProfileCicCriteria = (
  profile: ProfileSimpleMetrics,
  entity: UserGroupEntity
) => {
  return (
    hasGroupGotProfileCicCriteria(entity) &&
    isProfileCicOutOfGroupsBounds(profile, entity)
  );
};

export const isProfileViolatingTotalSentRepCriteria = (
  totalSentRepByProfile: number,
  entity: UserGroupEntity
) => {
  return (
    hasGroupGotTotalSentRepCriteria(entity) &&
    isRatingOutOfBounds({
      min: entity.rep_min,
      max: entity.rep_max,
      real: totalSentRepByProfile,
      minMaxNullMeansNonZeroRequired: true
    })
  );
};

export const isProfileViolatingTotalSentCicCriteria = (
  totalSentCicByProfile: number,
  entity: UserGroupEntity
) => {
  return (
    hasGroupGotTotalSentCicCriteria(entity) &&
    isRatingOutOfBounds({
      min: entity.cic_min,
      max: entity.cic_max,
      real: totalSentCicByProfile,
      minMaxNullMeansNonZeroRequired: true
    })
  );
};

const getTdhMetricFromProfile = (
  profile: ProfileSimpleMetrics,
  strategy: GroupTdhInclusionStrategy
): number => {
  switch (strategy) {
    case GroupTdhInclusionStrategy.TDH:
      return profile.tdh;
    case GroupTdhInclusionStrategy.XTDH:
      return Math.floor(profile.xtdh);
    case GroupTdhInclusionStrategy.BOTH:
      return Math.floor(profile.xtdh + profile.tdh);
    default:
      return assertUnreachable(strategy);
  }
};

const isProfileTdhOutOfGroupsBounds = (
  profile: ProfileSimpleMetrics,
  entity: UserGroupEntity
) => {
  const real = getTdhMetricFromProfile(profile, entity.tdh_inclusion_strategy);
  const min = entity.tdh_min;
  const max = entity.tdh_max;
  return isRatingOutOfBounds({
    min,
    max,
    real,
    minMaxNullMeansNonZeroRequired: false
  });
};

const isProfileLevelOutOfGroupsBounds = (
  profile: ProfileSimpleMetrics,
  entity: UserGroupEntity
) => {
  const real = profile.level;
  const min = entity.level_min;
  const max = entity.level_max;
  return isRatingOutOfBounds({
    min,
    max,
    real,
    minMaxNullMeansNonZeroRequired: false
  });
};

const isProfileRepOutOfGroupsBounds = (
  profile: ProfileSimpleMetrics,
  entity: UserGroupEntity
) => {
  const real = profile.rep;
  const min = entity.rep_min;
  const max = entity.rep_max;
  return isRatingOutOfBounds({
    min,
    max,
    real,
    minMaxNullMeansNonZeroRequired: false
  });
};

const isProfileCicOutOfGroupsBounds = (
  profile: ProfileSimpleMetrics,
  entity: UserGroupEntity
) => {
  const real = profile.cic;
  const min = entity.cic_min;
  const max = entity.cic_max;
  return isRatingOutOfBounds({
    min,
    max,
    real,
    minMaxNullMeansNonZeroRequired: false
  });
};

export const isAnyGroupByTotalSentCicOrRepCriteria = (
  groups: UserGroupEntity[]
): boolean => {
  return !!groups.find(
    (it) =>
      hasGroupGotTotalSentCicCriteria(it) || hasGroupGotTotalSentRepCriteria(it)
  );
};

export interface ProfileSimpleMetrics {
  readonly profile_id: string;
  readonly tdh: number;
  readonly xtdh: number;
  readonly level: number;
  readonly cic: number;
  readonly rep: number;
}
