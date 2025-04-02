import { FilterDirection, UserGroupEntity } from '../../../entities/IUserGroup';
import { NEXTGEN_CORE_CONTRACT } from '../../../nextgen/nextgen_constants';
import { Network } from 'alchemy-sdk';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../../../constants';
import { RateMatter } from '../../../entities/IRating';

export const isGroupByOwnsMeme = (entity: UserGroupEntity) => {
  return entity.owns_meme;
};

export const isGroupByOwnsMemeTokens = (entity: UserGroupEntity) => {
  const neededTokens: string[] = entity.owns_meme_tokens
    ? JSON.parse(entity.owns_meme_tokens)
    : [];
  return neededTokens.length;
};

export const isGroupByOwnsLab = (entity: UserGroupEntity) => {
  return entity.owns_lab;
};

export const isGroupByOwnsLabTokens = (entity: UserGroupEntity) => {
  const neededTokens: string[] = entity.owns_lab_tokens
    ? JSON.parse(entity.owns_lab_tokens)
    : [];
  return neededTokens.length;
};

export const isGroupByOwnsGradient = (entity: UserGroupEntity) => {
  return entity.owns_gradient;
};

export const isGroupByOwnsGradientTokens = (entity: UserGroupEntity) => {
  const neededTokens: string[] = entity.owns_gradient_tokens
    ? JSON.parse(entity.owns_gradient_tokens)
    : [];
  return neededTokens.length;
};

export const isGroupByOwnsNextGen = (entity: UserGroupEntity) => {
  return entity.owns_nextgen;
};

export const isGroupByOwnsNextGenTokens = (entity: UserGroupEntity) => {
  const neededTokens: string[] = entity.owns_nextgen_tokens
    ? JSON.parse(entity.owns_nextgen_tokens)
    : [];
  return neededTokens.length;
};

export const anyNftOwningsConditions = (entity: UserGroupEntity) => {
  return (
    isGroupByOwnsGradient(entity) ||
    isGroupByOwnsMeme(entity) ||
    isGroupByOwnsLab(entity) ||
    isGroupByOwnsNextGen(entity)
  );
};

export const allOwningsPredicatesMatch = (
  entity: UserGroupEntity,
  ownings: Record<string, string[]>
) => {
  if (isGroupByOwnsNextGen(entity)) {
    const actualOwnings =
      ownings[NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET].toLowerCase()] ?? [];
    if (isGroupByOwnsNextGenTokens(entity)) {
      const neededOwnings = JSON.parse(entity.owns_nextgen_tokens!) as string[];
      for (const neededOwning of neededOwnings) {
        if (!actualOwnings.includes(neededOwning.toLowerCase())) {
          return false;
        }
      }
    } else if (actualOwnings.length === 0) {
      return false;
    }
  }
  if (isGroupByOwnsGradient(entity)) {
    const actualOwnings = ownings[GRADIENT_CONTRACT.toLowerCase()] ?? [];
    if (isGroupByOwnsGradientTokens(entity)) {
      const neededOwnings = JSON.parse(
        entity.owns_gradient_tokens!
      ) as string[];
      for (const neededOwning of neededOwnings) {
        if (!actualOwnings.includes(neededOwning.toLowerCase())) {
          return false;
        }
      }
    } else if (actualOwnings.length === 0) {
      return false;
    }
  }
  if (isGroupByOwnsLab(entity)) {
    const actualOwnings = ownings[MEMELAB_CONTRACT.toLowerCase()] ?? [];
    if (isGroupByOwnsLabTokens(entity)) {
      const neededOwnings = JSON.parse(entity.owns_lab_tokens!) as string[];
      for (const neededOwning of neededOwnings) {
        if (!actualOwnings.includes(neededOwning.toLowerCase())) {
          return false;
        }
      }
    } else if (actualOwnings.length === 0) {
      return false;
    }
  }
  if (isGroupByOwnsMeme(entity)) {
    const actualOwnings = ownings[MEMES_CONTRACT.toLowerCase()] ?? [];
    if (isGroupByOwnsMemeTokens(entity)) {
      const neededOwnings = JSON.parse(entity.owns_meme_tokens!) as string[];
      for (const neededOwning of neededOwnings) {
        if (!actualOwnings.includes(neededOwning.toLowerCase())) {
          return false;
        }
      }
    } else if (actualOwnings.length === 0) {
      return false;
    }
  }
  return true;
};

export const isGroupByTotalGivenCic = (entity: UserGroupEntity) => {
  return (
    (entity.cic_min !== null || entity.cic_max !== null) &&
    entity.cic_user === null &&
    entity.cic_direction === FilterDirection.Sent
  );
};

export const isGroupByTotalGivenRep = (entity: UserGroupEntity) => {
  return (
    (entity.rep_min !== null || entity.rep_max !== null) &&
    entity.rep_user === null &&
    entity.rep_category === null &&
    entity.rep_direction === FilterDirection.Sent
  );
};

export const isGroupByTdh = (entity: UserGroupEntity) => {
  return entity.tdh_min !== null || entity.tdh_max !== null;
};

export const isGroupByLevel = (entity: UserGroupEntity) => {
  return entity.level_min !== null || entity.level_max !== null;
};

export const isGroupByTotalReceivedCic = (entity: UserGroupEntity) => {
  return (
    (entity.cic_min !== null || entity.cic_max !== null) &&
    entity.cic_user === null &&
    entity.cic_direction === FilterDirection.Received
  );
};

export const isGroupByTotalReceivedRep = (entity: UserGroupEntity) => {
  return (
    (entity.rep_min !== null || entity.rep_max !== null) &&
    entity.rep_user === null &&
    entity.rep_category === null &&
    entity.rep_direction === FilterDirection.Received
  );
};

export const isGroupTotalRepByUserOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.rep_category === null &&
    entity.rep_user !== null &&
    entity.rep_direction === FilterDirection.Sent
  );
};

export const isGroupTotalRepByUserIncoming = (entity: UserGroupEntity) => {
  return (
    entity.rep_category === null &&
    entity.rep_user !== null &&
    entity.rep_direction === FilterDirection.Received
  );
};

export const isGroupTotalRepForCategoryOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user === null &&
    entity.rep_direction === FilterDirection.Sent
  );
};

export const isGroupTotalRepForCategoryIncoming = (entity: UserGroupEntity) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user === null &&
    entity.rep_direction === FilterDirection.Received
  );
};

export const isGroupTotalRepByUserForCategoryOutgoing = (
  entity: UserGroupEntity
) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user !== null &&
    entity.rep_direction === FilterDirection.Sent
  );
};

export const isGroupTotalRepByUserForCategoryIncoming = (
  entity: UserGroupEntity
) => {
  return (
    entity.rep_category !== null &&
    entity.rep_user !== null &&
    entity.rep_direction === FilterDirection.Received
  );
};

export const isGroupTotalCicByUserOutgoing = (entity: UserGroupEntity) => {
  return (
    entity.cic_user !== null && entity.cic_direction === FilterDirection.Sent
  );
};

export const isGroupTotalCicByUserIncoming = (entity: UserGroupEntity) => {
  return (
    entity.cic_user !== null &&
    entity.cic_direction === FilterDirection.Received
  );
};

const sum = (ns: number[]) => ns.reduce((sum, n) => sum + n, 0);

function realCicRepRatingInBounds(
  requiredMin: number | null,
  requiredMax: number | null,
  realRating: number
) {
  if (requiredMin === null && requiredMax === null && realRating === 0) {
    return false;
  }
  return (
    (requiredMin === null || realRating >= requiredMin) &&
    (requiredMax === null || realRating <= requiredMax)
  );
}

export const allSpecificCicRepConditionsMatch = (
  entity: UserGroupEntity,
  myOutgoingRatings: {
    other_side_id: string;
    matter: RateMatter;
    matter_category: string;
    rating: number;
  }[],
  myIncomingRatings: {
    other_side_id: string;
    matter: RateMatter;
    matter_category: string;
    rating: number;
  }[]
) => {
  if (isGroupTotalRepByUserOutgoing(entity)) {
    const realRating = sum(
      myOutgoingRatings
        .filter(
          (it) =>
            it.matter === RateMatter.REP && it.other_side_id === entity.rep_user
        )
        .map((it) => it.rating)
    );
    if (!realCicRepRatingInBounds(entity.rep_min, entity.rep_max, realRating)) {
      return false;
    }
  }
  if (isGroupTotalRepByUserIncoming(entity)) {
    const realRating = sum(
      myIncomingRatings
        .filter(
          (it) =>
            it.matter === RateMatter.REP && it.other_side_id === entity.rep_user
        )
        .map((it) => it.rating)
    );
    if (!realCicRepRatingInBounds(entity.rep_min, entity.rep_max, realRating)) {
      return false;
    }
  }

  if (isGroupTotalRepForCategoryOutgoing(entity)) {
    const realRating = sum(
      myOutgoingRatings
        .filter(
          (it) =>
            it.matter === RateMatter.REP &&
            it.matter_category === entity.rep_category
        )
        .map((it) => it.rating)
    );
    if (!realCicRepRatingInBounds(entity.rep_min, entity.rep_max, realRating)) {
      return false;
    }
  }
  if (isGroupTotalRepForCategoryIncoming(entity)) {
    const realRating = sum(
      myIncomingRatings
        .filter(
          (it) =>
            it.matter === RateMatter.REP &&
            it.matter_category === entity.rep_category
        )
        .map((it) => it.rating)
    );
    if (!realCicRepRatingInBounds(entity.rep_min, entity.rep_max, realRating)) {
      return false;
    }
  }

  if (isGroupTotalRepByUserForCategoryOutgoing(entity)) {
    const realRating = sum(
      myOutgoingRatings
        .filter(
          (it) =>
            it.matter === RateMatter.REP &&
            it.matter_category === entity.rep_category &&
            it.other_side_id === entity.rep_user
        )
        .map((it) => it.rating)
    );
    if (!realCicRepRatingInBounds(entity.rep_min, entity.rep_max, realRating)) {
      return false;
    }
  }
  if (isGroupTotalRepByUserForCategoryIncoming(entity)) {
    const realRating = sum(
      myIncomingRatings
        .filter(
          (it) =>
            it.matter === RateMatter.REP &&
            it.matter_category === entity.rep_category &&
            it.other_side_id === entity.rep_user
        )
        .map((it) => it.rating)
    );
    if (!realCicRepRatingInBounds(entity.rep_min, entity.rep_max, realRating)) {
      return false;
    }
  }

  if (isGroupTotalCicByUserOutgoing(entity)) {
    const realRating = sum(
      myOutgoingRatings
        .filter(
          (it) =>
            it.matter === RateMatter.CIC && it.other_side_id === entity.cic_user
        )
        .map((it) => it.rating)
    );
    if (!realCicRepRatingInBounds(entity.cic_min, entity.cic_max, realRating)) {
      return false;
    }
  }
  if (isGroupTotalCicByUserIncoming(entity)) {
    const realRating = sum(
      myIncomingRatings
        .filter(
          (it) =>
            it.matter === RateMatter.CIC && it.other_side_id === entity.cic_user
        )
        .map((it) => it.rating)
    );
    if (!realCicRepRatingInBounds(entity.cic_min, entity.cic_max, realRating)) {
      return false;
    }
  }

  return true;
};

export const anyNonIdentityConditions = (entity: UserGroupEntity) => {
  return (
    anyNftOwningsConditions(entity) ||
    isGroupByTdh(entity) ||
    isGroupByLevel(entity) ||
    entity.rep_min !== null ||
    entity.rep_max !== null ||
    entity.cic_min !== null ||
    entity.cic_max !== null ||
    entity.cic_user !== null ||
    entity.rep_user !== null ||
    entity.rep_category !== null
  );
};
