import {
  fetchNextGenCollections,
  fetchNextGenTokensForCollection,
  fetchNextGenTokenTraits,
  persistNextGenCollection,
  persistNextGenCollectionHodlRate,
  persistNextGenTraits,
  persistNextGenTraitScores
} from './nextgen.db';
import {
  NextGenCollection,
  NextGenTokenScore,
  NextGenTokenTrait
} from '../entities/INextGen';
import { Logger } from '../logging';
import { EntityManager } from 'typeorm';
import { NFTS_TABLE } from '@/constants';
import { MINT_TYPE_TRAIT } from './nextgen_constants';

const logger = Logger.get('NEXTGEN_TOKENS');

const mintTypeTraitLower = MINT_TYPE_TRAIT.toLowerCase();

export async function refreshNextgenTokens(entityManager: EntityManager) {
  logger.info(`[REFRESHING NEXTGEN TOKENS]`);
  const collections = await fetchNextGenCollections(entityManager);
  await processCollections(entityManager, collections);
}

async function processCollections(
  entityManager: EntityManager,
  collections: NextGenCollection[]
) {
  const allTokenTraits = await fetchNextGenTokenTraits(entityManager);

  for (const collection of collections) {
    const collectionTokenTraits = allTokenTraits.filter(
      (tt) => tt.collection_id === collection.id
    );
    await processCollectionTraitScores(
      entityManager,
      collection,
      collectionTokenTraits
    );
  }
}

async function processCollectionTraitScores(
  entityManager: EntityManager,
  collection: NextGenCollection,
  tokenTraits: NextGenTokenTrait[]
) {
  const tokenCount = new Set(tokenTraits.map((item) => item.token_id)).size;
  const traitsCount = new Set(
    tokenTraits
      .filter((t) => !t.trait.toLowerCase().startsWith(mintTypeTraitLower))
      .map((item) => item.trait)
  ).size;

  logger.info(
    `[PROCESSING TRAIT SCORES] : [COLLECTION ${collection.id}] : [TOKEN COUNT ${tokenCount}]`
  );
  tokenTraits.forEach((tt) => {
    const name = tt.trait;
    const value = tt.value;

    tt.token_count = tokenCount;

    const sharedKey = tokenTraits.filter((tt) => tt.trait === name);
    tt.trait_count = new Set(sharedKey.map((item) => item.value)).size;

    tt.value_count = sharedKey.filter((tt) => tt.value === value).length;

    if (name.toLowerCase().startsWith(mintTypeTraitLower)) {
      tt.statistical_rarity = -1;
      tt.rarity_score = -1;
      tt.rarity_score_normalised = -1;
      tt.rarity_score_trait_count_normalised = -1;
      tt.statistical_rarity_normalised = -1;
      tt.single_trait_rarity_score_normalised = -1;
    } else {
      const sharedKeyValue = sharedKey.filter(
        (tt) => tt.value === value
      ).length;

      const valuesCountForTrait = new Set(sharedKey.map((item) => item.value))
        .size;

      const statisticalScore = sharedKeyValue / tokenCount;
      tt.statistical_rarity = statisticalScore;
      tt.single_trait_rarity_score_normalised =
        statisticalScore * valuesCountForTrait;
      tt.statistical_rarity_normalised =
        statisticalScore ** (1 / valuesCountForTrait);
      tt.rarity_score = tokenCount / sharedKeyValue;

      tt.rarity_score_normalised =
        ((1 / sharedKeyValue) * 1000000) / (traitsCount * valuesCountForTrait);

      tt.rarity_score_trait_count_normalised =
        ((1 / sharedKeyValue) * 1000000) /
        ((traitsCount + 1) * valuesCountForTrait);
    }
  });

  let rankedTraits = calulateTokenRanks(tokenTraits, 'rarity_score');
  rankedTraits = calulateTokenRanks(rankedTraits, 'rarity_score_normalised');
  rankedTraits = calulateTokenRanks(rankedTraits, 'statistical_rarity');
  rankedTraits = calulateTokenRanks(
    rankedTraits,
    'statistical_rarity_normalised'
  );
  rankedTraits = calulateTokenRanks(
    rankedTraits,
    'single_trait_rarity_score_normalised'
  );
  rankedTraits = calulateTokenRanks(
    rankedTraits,
    'rarity_score_trait_count_normalised'
  );

  await persistNextGenTraits(entityManager, rankedTraits);

  await processTokens(entityManager, collection);
}

async function processTokens(
  entityManager: EntityManager,
  collection: NextGenCollection
) {
  const tokens = await fetchNextGenTokensForCollection(
    entityManager,
    collection
  );

  await processCollectionHodlRate(entityManager, collection, tokens.length);

  const traitScores: NextGenTokenScore[] = [];
  const traitCountPerToken = new Map<number, number>();
  const traitsPerToken = new Map<number, NextGenTokenTrait[]>();

  const traitCategories = new Set<string>();
  const traitCategoriesWithNone = new Set<string>();
  for (const token of tokens) {
    const tokenTraits = await entityManager
      .getRepository(NextGenTokenTrait)
      .find({
        where: {
          token_id: token.id
        }
      });

    const filteredTokenTraits = tokenTraits.filter((tt) => {
      const traitLower = tt.trait.toLowerCase();
      return !traitLower.startsWith(mintTypeTraitLower);
    });

    filteredTokenTraits.forEach((t) => {
      if (t.value.toLowerCase().startsWith('none')) {
        traitCategoriesWithNone.add(t.trait);
      }
      traitCategories.add(t.trait);
    });

    const traitCount = new Set(
      filteredTokenTraits
        .filter((t) => !t.value.toLowerCase().startsWith('none'))
        .map((t) => t.trait)
    ).size;

    traitCountPerToken.set(token.id, traitCount);
    traitsPerToken.set(token.id, filteredTokenTraits);
  }

  for (const token of tokens) {
    const filteredTokenTraits = traitsPerToken.get(token.id) || [];
    const {
      rarityScore,
      rarityScoreNormalised,
      rarityScoreTraitCountNormalised,
      statisticalScore,
      statisticalScoreNormalised
    } = filteredTokenTraits.reduce(
      (acc, tt) => {
        acc.rarityScore += tt.rarity_score;
        acc.rarityScoreNormalised += tt.rarity_score_normalised;
        acc.rarityScoreTraitCountNormalised +=
          tt.rarity_score_trait_count_normalised;
        acc.statisticalScore *= tt.statistical_rarity;
        acc.statisticalScoreNormalised *= tt.statistical_rarity_normalised;
        return acc;
      },
      {
        rarityScore: 0,
        rarityScoreNormalised: 0,
        rarityScoreTraitCountNormalised: 0,
        statisticalScore: 1,
        statisticalScoreNormalised: 1
      }
    );

    let singleTraitRarity = 0;
    let singleTraitRarityNormalised = 0;
    if (filteredTokenTraits.length > 0) {
      singleTraitRarity = Math.min(
        ...filteredTokenTraits.map((t) => t.statistical_rarity)
      );
      singleTraitRarityNormalised = Math.min(
        ...filteredTokenTraits.map(
          (t) => t.single_trait_rarity_score_normalised
        )
      );
    }

    const traitCount = traitCountPerToken.get(token.id) ?? 0;
    const denominator = Array.from(traitCountPerToken.values()).filter(
      (tc) => tc === traitCount
    ).length;
    const rarityScoreTraitCount = tokens.length / denominator + rarityScore;

    const rarityScoreTraitCountNormalisedAdjustement =
      ((1 / denominator) * 1000000) /
      ((traitCategories.size + 1) * (traitCategoriesWithNone.size + 1));

    const rarityScoreTraitCountNormalisedAdjusted =
      rarityScoreTraitCountNormalised +
      rarityScoreTraitCountNormalisedAdjustement;

    const statisticalScoreTraitCount =
      statisticalScore * (denominator / tokens.length);

    const statisticalScoreTraitCountNormalised =
      statisticalScoreNormalised *
      (denominator / tokens.length) ** (1 / (traitCategoriesWithNone.size + 1));

    const singleTraitRarityTraitCount = Math.min(
      singleTraitRarity,
      denominator / tokens.length
    );

    const singleTraitRarityTraitCountNormalization =
      (denominator / tokens.length) * (traitCategoriesWithNone.size + 1);

    const minSingleTraitRarityNormalised = Math.min(
      ...filteredTokenTraits.map((t) => t.single_trait_rarity_score_normalised)
    );

    const singleTraitRarityTraitCountNormalised = Math.min(
      minSingleTraitRarityNormalised,
      singleTraitRarityTraitCountNormalization
    );

    traitScores.push({
      id: token.id,
      collection_id: token.collection_id,
      rarity_score: rarityScore,
      rarity_score_normalised: rarityScoreNormalised,
      statistical_score: statisticalScore,
      statistical_score_normalised: statisticalScoreNormalised,
      single_trait_rarity_score: singleTraitRarity,
      single_trait_rarity_score_trait_count: singleTraitRarityTraitCount,
      single_trait_rarity_score_normalised: singleTraitRarityNormalised,
      single_trait_rarity_score_trait_count_normalised:
        singleTraitRarityTraitCountNormalised,
      rarity_score_trait_count: rarityScoreTraitCount,
      rarity_score_trait_count_normalised:
        rarityScoreTraitCountNormalisedAdjusted,
      statistical_score_trait_count: statisticalScoreTraitCount,
      statistical_score_trait_count_normalised:
        statisticalScoreTraitCountNormalised
    });
  }

  // rarity_score ranks
  const rarityScoreRanks = calculateRanks(traitScores, 'rarity_score');
  const rarityScoreTraitCountRanks = calculateRanks(
    traitScores,
    'rarity_score_trait_count'
  );
  const rarityScoreNormalisedRanks = calculateRanks(
    traitScores,
    'rarity_score_normalised'
  );
  const rarityScoreTraitCountNormalisedRanks = calculateRanks(
    traitScores,
    'rarity_score_trait_count_normalised'
  );

  // statistical_score ranks
  const statisticalScoreRanks = calculateRanks(
    traitScores,
    'statistical_score',
    true
  );
  const statisticalScoreTraitCountRanks = calculateRanks(
    traitScores,
    'statistical_score_trait_count',
    true
  );
  const statisticalScoreNormalisedRanks = calculateRanks(
    traitScores,
    'statistical_score_normalised',
    true
  );
  const statisticalScoreTraitCountNormalisedRanks = calculateRanks(
    traitScores,
    'statistical_score_trait_count_normalised',
    true
  );

  // single_trait_rarity_score ranks
  const singleTraitScoreRanks = calculateRanks(
    traitScores,
    'single_trait_rarity_score',
    true
  );
  const singleTraitScoreTraitCountRanks = calculateRanks(
    traitScores,
    'single_trait_rarity_score_trait_count',
    true
  );
  const singleTraitScoreNormalisedRanks = calculateRanks(
    traitScores,
    'single_trait_rarity_score_normalised',
    true
  );
  const singleTraitScoreTraitCountNormalisedRanks = calculateRanks(
    traitScores,
    'single_trait_rarity_score_trait_count_normalised',
    true
  );

  const rankedTraitScores: NextGenTokenScore[] = traitScores.map((score) => ({
    ...score,
    rarity_score_rank: rarityScoreRanks.get(score.id),
    rarity_score_normalised_rank: rarityScoreNormalisedRanks.get(score.id),
    rarity_score_trait_count_rank: rarityScoreTraitCountRanks.get(score.id),
    rarity_score_trait_count_normalised_rank:
      rarityScoreTraitCountNormalisedRanks.get(score.id),
    statistical_score_rank: statisticalScoreRanks.get(score.id),
    statistical_score_normalised_rank: statisticalScoreNormalisedRanks.get(
      score.id
    ),
    statistical_score_trait_count_rank: statisticalScoreTraitCountRanks.get(
      score.id
    ),
    statistical_score_trait_count_normalised_rank:
      statisticalScoreTraitCountNormalisedRanks.get(score.id),
    single_trait_rarity_score_rank: singleTraitScoreRanks.get(score.id),
    single_trait_rarity_score_normalised_rank:
      singleTraitScoreNormalisedRanks.get(score.id),
    single_trait_rarity_score_trait_count_rank:
      singleTraitScoreTraitCountRanks.get(score.id),
    single_trait_rarity_score_trait_count_normalised_rank:
      singleTraitScoreTraitCountNormalisedRanks.get(score.id)
  }));

  await persistNextGenTraitScores(entityManager, rankedTraitScores);
}

const calculateRanks = (
  scores: NextGenTokenScore[],
  scoreKey: keyof NextGenTokenScore,
  inverse = false
): Map<number, number> => {
  const sortedScores = [...scores].sort((a, b) => {
    const aValue = a[scoreKey];
    const bValue = b[scoreKey];

    if (typeof aValue === 'number' && typeof bValue === 'number') {
      return inverse ? aValue - bValue : bValue - aValue;
    }

    return 0;
  });

  const ranks = new Map<number, number>();
  let currentRank = 1;
  let previousScore: number | null = null;

  sortedScores.forEach((score, index) => {
    if (previousScore !== null && score[scoreKey] === previousScore) {
      ranks.set(score.id, currentRank);
    } else {
      currentRank = index + 1;
      ranks.set(score.id, currentRank);
      previousScore = score[scoreKey] as number;
    }
  });

  return ranks;
};

function calulateTokenRanks(
  startingTraits: NextGenTokenTrait[],
  field: string
) {
  const categories = new Set<string>(startingTraits.map((tt) => tt.trait));

  const rankedTokens = Array.from(categories).map((category) => {
    const traits = startingTraits.filter((tt) => tt.trait === category);
    return calculateTokenRanksForCategory(traits, field);
  });
  return rankedTokens.flat();
}

function calculateTokenRanksForCategory(
  startingTraits: NextGenTokenTrait[],
  field: string
) {
  const tokenTraits = [...startingTraits] as any[];
  const sortedTraits = tokenTraits.sort((a, b) => b[field] - a[field]);

  let currentRank = 1;
  let previousValue = sortedTraits[0][field];

  sortedTraits.forEach((tt) => {
    if (tt[field] !== previousValue) {
      currentRank += 1;
      previousValue = tt[field];
    }
    tt[`${field}_rank`] = currentRank;
  });

  return sortedTraits;
}

async function processCollectionHodlRate(
  entityManager: EntityManager,
  collection: NextGenCollection,
  tokens: number
) {
  const nftMaxSupply = (
    await entityManager.query(
      `SELECT MAX(supply) AS maxSupply FROM ${NFTS_TABLE}`
    )
  )[0].maxSupply;

  let hodlRate = 0;
  if (tokens > 0) {
    hodlRate = nftMaxSupply / tokens;
  }

  logger.info(
    `[COLLECTION ${collection.id}] : [TOKENS ${tokens}] : [NFT MAX SUPPLY ${nftMaxSupply}] : [HODL RATE ${hodlRate}]`
  );

  await persistNextGenCollectionHodlRate(
    entityManager,
    collection.id,
    hodlRate
  );

  logger.info(
    `[SETTING COLLECTION ${collection.id} MINT COUNT TO ${tokens}] : [COLLECTION ${collection.id}]`
  );
  collection.mint_count = tokens;
  await persistNextGenCollection(entityManager, collection);
}
