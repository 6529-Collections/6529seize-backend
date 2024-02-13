import {
  fetchNextGenCollections,
  persistNextGenTraits,
  fetchNextGenTokenTraits,
  fetchNextGenTokensForCollection,
  persistNextGenCollectionHodlRate,
  persistNextGenCollection,
  persistNextGenTraitScores
} from './nextgen.db';
import {
  NextGenCollection,
  NextGenTokenTrait,
  NextGenTokenScore
} from '../entities/INextGen';
import { Logger } from '../logging';
import { EntityManager } from 'typeorm';
import { NFTS_TABLE } from '../constants';
import { COLLECTION_NAME_TRAIT, MINT_TYPE_TRAIT } from './nextgen_constants';

const logger = Logger.get('NEXTGEN_TOKENS');

const mintTypeTraitLower = MINT_TYPE_TRAIT.toLowerCase();
const collectionNameTraitLower = COLLECTION_NAME_TRAIT.toLowerCase();

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
  const traitsCount = new Set(tokenTraits.map((item) => item.trait)).size;

  logger.info(
    `[PROCESSING TRAIT SCORES] : [COLLECTION ${collection.id}] : [TOKEN COUNT ${tokenCount}]`
  );
  tokenTraits.forEach((tt) => {
    const name = tt.trait;
    const value = tt.value;

    tt.token_count = tokenCount;

    const sharedKey = tokenTraits.filter((tt) => tt.trait === name);
    tt.trait_count = new Set(sharedKey.map((item) => item.value)).size;

    const valueCount = sharedKey.filter((tt) => tt.value === value).length;
    tt.value_count = valueCount;

    if (
      name.toLowerCase().startsWith(mintTypeTraitLower) ||
      name.toLowerCase() === collectionNameTraitLower
    ) {
      tt.statistical_rarity = -1;
      tt.rarity_score = -1;
      tt.rarity_score_normalised = -1;
    } else {
      const sharedKeyValue = sharedKey.filter(
        (tt) => tt.value === value
      ).length;

      const valuesCountForTrait = new Set(sharedKey.map((item) => item.value))
        .size;

      tt.statistical_rarity = sharedKeyValue / tokenCount;
      tt.rarity_score = tokenCount / sharedKeyValue;
      tt.rarity_score_normalised =
        ((1 / sharedKeyValue) * 1000000) /
        ((traitsCount + 1) * (valuesCountForTrait + 1));
    }
  });

  let rankedTraits = calulateTokenRanks(tokenTraits, 'rarity_score');
  rankedTraits = calulateTokenRanks(rankedTraits, 'rarity_score_normalised');
  rankedTraits = calulateTokenRanks(rankedTraits, 'statistical_rarity');

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
      return (
        !traitLower.startsWith(mintTypeTraitLower) &&
        traitLower !== collectionNameTraitLower
      );
    });

    const { rarityScore, rarityScoreNormalised, statisticalScore } =
      filteredTokenTraits.reduce(
        (acc, tt) => {
          acc.rarityScore += tt.rarity_score;
          acc.rarityScoreNormalised += tt.rarity_score_normalised;
          acc.statisticalScore *= tt.statistical_rarity;
          return acc;
        },
        { rarityScore: 0, rarityScoreNormalised: 0, statisticalScore: 1 }
      );

    let singleTraitRarity = 0;
    if (filteredTokenTraits.length > 0) {
      singleTraitRarity = Math.min(
        ...filteredTokenTraits.map((t) => t.statistical_rarity)
      );
    }

    traitScores.push({
      id: token.id,
      collection_id: token.collection_id,
      rarity_score: rarityScore,
      rarity_score_normalised: rarityScoreNormalised,
      statistical_score: statisticalScore,
      single_trait_rarity_score: singleTraitRarity
    });
  }

  const rarityScoreRanks = calculateRanks(traitScores, 'rarity_score');
  const rarityScoreNormalisedRanks = calculateRanks(
    traitScores,
    'rarity_score_normalised'
  );
  const statisticalScoreRanks = calculateRanks(
    traitScores,
    'statistical_score',
    true
  );
  const singleTraitScoreRanks = calculateRanks(
    traitScores,
    'single_trait_rarity_score',
    true
  );

  const rankedTraitScores: NextGenTokenScore[] = traitScores.map((score) => ({
    ...score,
    rarity_score_rank: rarityScoreRanks.get(score.id),
    rarity_score_normalised_rank: rarityScoreNormalisedRanks.get(score.id),
    statistical_score_rank: statisticalScoreRanks.get(score.id),
    single_trait_rarity_score_rank: singleTraitScoreRanks.get(score.id)
  }));

  await persistNextGenTraitScores(entityManager, rankedTraitScores);
}

const calculateRanks = (
  scores: NextGenTokenScore[],
  scoreKey: keyof NextGenTokenScore,
  inverse: boolean = false
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

  sortedTraits.forEach((tt, index) => {
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
