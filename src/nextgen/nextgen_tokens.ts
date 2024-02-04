import {
  fetchNextGenCollections,
  persistNextGenTraits,
  fetchNextGenTokenTraits,
  fetchNextGenTokensForCollection,
  persistNextGenCollectionHodlRate
} from './nextgen.db';
import {
  NextGenCollection,
  NextGenTokenTrait,
  NextGenTokenScore
} from '../entities/INextGen';
import { Logger } from '../logging';
import { EntityManager } from 'typeorm';
import { getNftMaxSupply } from '../db';

const logger = Logger.get('NEXTGEN_TOKENS');

export async function refreshNextgenTokens(entityManager: EntityManager) {
  const collections = await fetchNextGenCollections(entityManager);

  await processCollections(entityManager, collections);
}

async function processCollections(
  entityManager: EntityManager,
  collections: NextGenCollection[]
) {
  const tokenTraits = await fetchNextGenTokenTraits(entityManager);

  for (const collection of collections) {
    const collectionTokenTraits = tokenTraits.filter(
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
    tt.trait_count = tokenTraits.length;

    const valueCount = sharedKey.filter((tt) => tt.value === value).length;
    tt.value_count = valueCount;

    const sharedKeyValue = sharedKey.filter((tt) => tt.value === value).length;
    tt.rarity = (sharedKeyValue / tokenCount) * 100;
    tt.rarity_score = tokenCount / sharedKeyValue;

    const valuesCountForTrait = new Set(sharedKey.map((item) => item.value))
      .size;

    tt.rarity_score_normalised =
      ((1 / sharedKeyValue) * 1000000) /
      ((traitsCount + 1) * (valuesCountForTrait + 1));
  });

  let rankedTraits = calulateTokenRanks(tokenTraits, 'rarity_score');
  rankedTraits = calulateTokenRanks(rankedTraits, 'rarity_score_normalised');
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
    const traits = await entityManager.getRepository(NextGenTokenTrait).find({
      where: {
        token_id: token.id
      }
    });

    const { rarityScore, rarityScoreNormalised, statisticalScore } =
      traits.reduce(
        (acc, tt) => {
          acc.rarityScore += tt.rarity_score;
          acc.rarityScoreNormalised += tt.rarity_score_normalised;
          acc.statisticalScore *= tt.rarity / 100;
          return acc;
        },
        { rarityScore: 0, rarityScoreNormalised: 0, statisticalScore: 1 }
      );

    traitScores.push({
      id: token.id,
      collection_id: token.collection_id,
      rarity_score: rarityScore,
      rarity_score_normalised: rarityScoreNormalised,
      statistical_score: statisticalScore
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

  const rankedTraitScores: NextGenTokenScore[] = traitScores.map((score) => ({
    ...score,
    rarity_score_rank: rarityScoreRanks.get(score.id),
    rarity_score_normalised_rank: rarityScoreNormalisedRanks.get(score.id),
    statistical_score_rank: statisticalScoreRanks.get(score.id)
  }));

  await entityManager.getRepository(NextGenTokenScore).save(rankedTraitScores);
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
  const tokenTraits = startingTraits as any[];
  const sortedTraits = tokenTraits.sort(
    (a: any, b: any) => b[field] - a[field]
  );

  let currentRank = 1;
  let previousScore = tokenTraits[0][field];
  let itemsAtCurrentRank = 1;

  sortedTraits.forEach((tt, index) => {
    if (index === 0) {
      tt[`${field}_rank`] = currentRank;
    } else {
      if (tt.rarity_score === previousScore) {
        tt[`${field}_rank`] = currentRank;
        itemsAtCurrentRank++;
      } else {
        currentRank += itemsAtCurrentRank;
        tt[`${field}_rank`] = currentRank;
        previousScore = tt[field];
        itemsAtCurrentRank = 1;
      }
    }
  });

  return sortedTraits as NextGenTokenTrait[];
}

async function processCollectionHodlRate(
  entityManager: EntityManager,
  collection: NextGenCollection,
  tokens: number
) {
  const nftMaxSupply = await getNftMaxSupply();

  const hodlRate = nftMaxSupply / tokens;

  logger.info(
    `[COLLECTION ${collection.id}] : [TOKENS ${tokens}] : [NFT MAX SUPPLY ${nftMaxSupply}] : [HODL RATE ${hodlRate}]`
  );

  await persistNextGenCollectionHodlRate(
    entityManager,
    collection.id,
    hodlRate
  );
}
