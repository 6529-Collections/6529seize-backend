import { FilterDirection, UserGroupEntity } from '../../../entities/IUserGroup';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../../../constants';
import { RateMatter } from '../../../entities/IRating';
import { sum } from '../../../helpers';
import { ProfileSimpleMetrics } from '../../../user-groups/user-groups.db';
import { NEXTGEN_CORE_CONTRACT } from '../../../nextgen/nextgen_constants';
import { Network } from 'alchemy-sdk';

const hasGroupGotOwnsMemeCriteria = (entity: UserGroupEntity) => {
  return entity.owns_meme;
};

const hasGroupGotOwnsLabCriteria = (entity: UserGroupEntity) => {
  return entity.owns_lab;
};

const hasGroupGotOwnsGradientCriteria = (entity: UserGroupEntity) => {
  return entity.owns_gradient;
};

const hasGroupGotOwnsNextGenCriteria = (entity: UserGroupEntity) => {
  return entity.owns_nextgen;
};

const isGroupByOwningsCriteria = (entity: UserGroupEntity) => {
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

const isProfileHavingContractTokenOwningsMisMatch = ({
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
    return false;
  }
  const neededTokens = (
    neededTokensString ? JSON.parse(neededTokensString) : []
  ) as string[];
  return (
    neededTokens.length !== 0 &&
    !!neededTokens.find((it) => !profilesCollectionOwnings.includes(it))
  );
};

const isProfileViolatingOwnsNextGenCriteria = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
) => {
  if (hasGroupGotOwnsNextGenCriteria(entity)) {
    if (
      isProfileHavingContractTokenOwningsMisMatch({
        neededContract: NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET],
        neededTokensString: entity.owns_nextgen_tokens,
        ownings
      })
    ) {
      return true;
    }
  }
  return false;
};

const isProfileViolatingGradientCriteria = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
) => {
  if (hasGroupGotOwnsGradientCriteria(entity)) {
    if (
      isProfileHavingContractTokenOwningsMisMatch({
        neededContract: GRADIENT_CONTRACT,
        neededTokensString: entity.owns_gradient_tokens,
        ownings
      })
    ) {
      return true;
    }
  }
  return false;
};

const isProfileViolatingLabCriteria = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
) => {
  if (hasGroupGotOwnsLabCriteria(entity)) {
    if (
      isProfileHavingContractTokenOwningsMisMatch({
        neededContract: MEMELAB_CONTRACT,
        neededTokensString: entity.owns_lab_tokens,
        ownings
      })
    ) {
      return true;
    }
  }
  return false;
};

const isProfileViolatingMemesCriteria = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
) => {
  if (hasGroupGotOwnsMemeCriteria(entity)) {
    if (
      isProfileHavingContractTokenOwningsMisMatch({
        neededContract: MEMES_CONTRACT,
        neededTokensString: entity.owns_meme_tokens,
        ownings
      })
    ) {
      return true;
    }
  }
  return false;
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

const hasGroupGotTotalSentCicCriteria = (entity: UserGroupEntity) => {
  return (
    (entity.cic_min !== null || entity.cic_max !== null) &&
    entity.cic_user === null &&
    entity.cic_direction === FilterDirection.Sent
  );
};

const hasGroupGotTotalSentRepCriteria = (entity: UserGroupEntity) => {
  return (
    (entity.rep_min !== null || entity.rep_max !== null) &&
    entity.rep_user === null &&
    entity.rep_category === null &&
    entity.rep_direction === FilterDirection.Sent
  );
};

const hasGroupGotProfileTdhCriteria = (entity: UserGroupEntity) => {
  return entity.tdh_min !== null || entity.tdh_max !== null;
};

const hasGroupGotProfileLevelCriteria = (entity: UserGroupEntity) => {
  return entity.level_min !== null || entity.level_max !== null;
};

const hasGroupGotProfileCicCriteria = (entity: UserGroupEntity) => {
  return (
    (entity.cic_min !== null || entity.cic_max !== null) &&
    entity.cic_user === null &&
    entity.cic_direction === FilterDirection.Received
  );
};

const hasGroupGotProfileRepCriteria = (entity: UserGroupEntity) => {
  return (
    (entity.rep_min !== null || entity.rep_max !== null) &&
    entity.rep_user === null &&
    entity.rep_category === null &&
    entity.rep_direction === FilterDirection.Received
  );
};

const isGroupTotalRepByUserOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.rep_category === null &&
    entity.rep_user !== null &&
    entity.rep_direction === FilterDirection.Sent
  );
};

const isGroupTotalRepByUserIncoming = (entity: UserGroupEntity) => {
  return (
    entity.rep_category === null &&
    entity.rep_user !== null &&
    entity.rep_direction === FilterDirection.Received
  );
};

const isGroupTotalRepForCategoryOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user === null &&
    entity.rep_direction === FilterDirection.Sent
  );
};

const isGroupTotalRepForCategoryIncoming = (entity: UserGroupEntity) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user === null &&
    entity.rep_direction === FilterDirection.Received
  );
};

const isGroupTotalRepByUserForCategoryOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user !== null &&
    entity.rep_direction === FilterDirection.Sent
  );
};

const isGroupTotalRepByUserForCategoryIncoming = (entity: UserGroupEntity) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user !== null &&
    entity.rep_direction === FilterDirection.Received
  );
};

const isGroupTotalCicByUserOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.cic_user !== null && entity.cic_direction === FilterDirection.Sent
  );
};

const isGroupTotalCicByUserIncoming = (entity: UserGroupEntity) => {
  return (
    entity.cic_user !== null &&
    entity.cic_direction === FilterDirection.Received
  );
};

function isRatingOutOfBounds({
  min,
  max,
  real,
  minMaxNullMeansNonZeroRequired
}: {
  min: number | null;
  max: number | null;
  real: number;
  minMaxNullMeansNonZeroRequired: boolean;
}) {
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
}

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
  const real = sum(
    ratings.filter((it) => sumCriteria(it, group)).map((it) => it.rating)
  );
  return isRatingOutOfBounds({
    min,
    max,
    real,
    minMaxNullMeansNonZeroRequired: true
  });
}

export function isGroupViolatingAnySpecificRepCriteria(
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
) {
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
}

export function isGroupViolatingAnySpecificCicCriteria(
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
) {
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
}

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
    entity.rep_category !== null
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

const isProfileTdhOutOfGroupsBounds = (
  profile: ProfileSimpleMetrics,
  entity: UserGroupEntity
) => {
  const real = profile.tdh;
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
