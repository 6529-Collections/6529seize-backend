import { MemesSeason } from '@/entities/ISeason';
import { DefaultBoost } from '@/entities/ITDH';
import { numbers } from '@/numbers';

export const BASE_TDH_MULTIPLIER = 1;
export const TDH_BOOST_ROUNDING_DECIMALS = 2;
export const MEMES_SEASON_SET_BOOST = 0.05;
export const LAST_BOOSTED_MEMES_SEASON = 20;
export const ADDITIONAL_CARD_SET_BOOST = 0.05;
export const ADDITIONAL_CARD_SET_RATIO = 0.6529;
export const GENESIS_SET_BOOST = 0.01;
export const GENESIS_SET_TOKEN_IDS = [1, 2, 3] as const;
export const NAKAMOTO_BOOST = 0.01;
export const NAKAMOTO_TOKEN_IDS = [4] as const;
export const GRADIENT_BOOST_PER_TOKEN = 0.02;
export const MAX_BOOSTED_GRADIENTS = 5;
export const MAX_GRADIENT_BOOST =
  GRADIENT_BOOST_PER_TOKEN * MAX_BOOSTED_GRADIENTS;

export interface TdhBoostRules {
  baseMultiplier: number;
  finalRoundingDecimals: number;
  seasonSchedule: {
    bonusPerSeason: number;
    lastBoostedSeason: number;
    maxBonus: number;
  };
  seasonSets: Array<{
    season: number;
    startIndex: number;
    endIndex: number;
    count: number;
    bonus: number;
  }>;
  fullCollection: {
    firstSetBonus: number;
    additionalSetInitialBonus: number;
    additionalSetDecayRatio: number;
    additionalSetsLimitBonus: number;
  };
  seasonOnePartials: Array<{
    key: 'genesis' | 'nakamoto';
    tokenIds: number[];
    bonus: number;
  }>;
  gradients: {
    bonusPerToken: number;
    maxCount: number;
    maxBonus: number;
  };
}

export function roundBoostValue(value: number): number {
  return numbers.roundDecimals(value, 6);
}

export function getAdjustedSeasons(
  seasons: MemesSeason[],
  eligibleMemesCount: number
): MemesSeason[] {
  return seasons.filter((season) => eligibleMemesCount >= season.start_index);
}

export function getBoostableSeasons(seasons: MemesSeason[]): MemesSeason[] {
  const maxSeasonId =
    seasons.length > 0 ? Math.max(...seasons.map((season) => season.id)) : 0;
  return seasons.filter(
    (season) => season.id < maxSeasonId && season.boost > 0
  );
}

export function getFullCollectionSetBoost(seasons: MemesSeason[]): number {
  return roundBoostValue(
    getBoostableSeasons(seasons).reduce((sum, season) => sum + season.boost, 0)
  );
}

export function getAdditionalCardSetsBoost(additionalCardSets: number): number {
  if (additionalCardSets <= 0) {
    return 0;
  }

  return roundBoostValue(
    (ADDITIONAL_CARD_SET_BOOST *
      (1 - Math.pow(ADDITIONAL_CARD_SET_RATIO, additionalCardSets))) /
      (1 - ADDITIONAL_CARD_SET_RATIO)
  );
}

export function getAdditionalCardSetsBoostLimit(): number {
  return roundBoostValue(
    ADDITIONAL_CARD_SET_BOOST / (1 - ADDITIONAL_CARD_SET_RATIO)
  );
}

export function getDefaultBoost(seasons: MemesSeason[] = []): DefaultBoost {
  const fullCollectionSetBoost = getFullCollectionSetBoost(seasons);
  const boost: DefaultBoost = {
    memes_card_sets: {
      available: roundBoostValue(
        fullCollectionSetBoost + getAdditionalCardSetsBoostLimit()
      ),
      available_info: [
        `${fullCollectionSetBoost} for Full Collection Set`,
        `${ADDITIONAL_CARD_SET_BOOST} * ${ADDITIONAL_CARD_SET_RATIO}^(n-1) for each additional set (unlimited)`
      ],
      acquired: 0,
      acquired_info: []
    },
    memes_genesis: {
      available: GENESIS_SET_BOOST,
      available_info: [
        `${GENESIS_SET_BOOST} for Meme Cards #1, #2, #3 (Genesis Set)`
      ],
      acquired: 0,
      acquired_info: []
    },
    memes_nakamoto: {
      available: NAKAMOTO_BOOST,
      available_info: [`${NAKAMOTO_BOOST} for Meme Card #4 (NakamotoFreedom)`],
      acquired: 0,
      acquired_info: []
    },
    gradients: {
      available: MAX_GRADIENT_BOOST,
      available_info: [
        `${GRADIENT_BOOST_PER_TOKEN} for each Gradient up to ${MAX_BOOSTED_GRADIENTS}`
      ],
      acquired: 0,
      acquired_info: []
    }
  };

  getBoostableSeasons(seasons).forEach((season) => {
    boost[`memes_szn${season.id}` as keyof DefaultBoost] = {
      available: season.boost,
      available_info: [`${season.boost} for Season ${season.id} Set`],
      acquired: 0,
      acquired_info: []
    };
  });

  return boost;
}

export function getTdhBoostRules(seasons: MemesSeason[]): TdhBoostRules {
  const seasonSets = getBoostableSeasons(seasons).map((season) => ({
    season: season.id,
    startIndex: season.start_index,
    endIndex: season.end_index,
    count: season.count,
    bonus: season.boost
  }));

  return {
    baseMultiplier: BASE_TDH_MULTIPLIER,
    finalRoundingDecimals: TDH_BOOST_ROUNDING_DECIMALS,
    seasonSchedule: {
      bonusPerSeason: MEMES_SEASON_SET_BOOST,
      lastBoostedSeason: LAST_BOOSTED_MEMES_SEASON,
      maxBonus: roundBoostValue(
        MEMES_SEASON_SET_BOOST * LAST_BOOSTED_MEMES_SEASON
      )
    },
    seasonSets,
    fullCollection: {
      firstSetBonus: getFullCollectionSetBoost(seasons),
      additionalSetInitialBonus: ADDITIONAL_CARD_SET_BOOST,
      additionalSetDecayRatio: ADDITIONAL_CARD_SET_RATIO,
      additionalSetsLimitBonus: getAdditionalCardSetsBoostLimit()
    },
    seasonOnePartials: [
      {
        key: 'genesis',
        tokenIds: [...GENESIS_SET_TOKEN_IDS],
        bonus: GENESIS_SET_BOOST
      },
      {
        key: 'nakamoto',
        tokenIds: [...NAKAMOTO_TOKEN_IDS],
        bonus: NAKAMOTO_BOOST
      }
    ],
    gradients: {
      bonusPerToken: GRADIENT_BOOST_PER_TOKEN,
      maxCount: MAX_BOOSTED_GRADIENTS,
      maxBonus: MAX_GRADIENT_BOOST
    }
  };
}
