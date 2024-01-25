import {
  fetchNextGenCollections,
  persistNextGenTraits,
  fetchNextGenTokenTraits,
  fetchPendingNextgenTokens,
  fetchNextGenTokensForCollection
} from './nextgen.db';
import {
  NextGenCollection,
  NextGenToken,
  NextGenTokenTrait
} from '../entities/INextGen';
import { Logger } from '../logging';
import { EntityManager } from 'typeorm';

const logger = Logger.get('NEXTGEN_TRAITS');

export async function processTraitScores(entityManager: EntityManager) {
  const collections = await fetchNextGenCollections(entityManager);
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
    tt.trait_count = sharedKey.length;

    const sharedKeyValue = sharedKey.filter((tt) => tt.value === value).length;
    tt.rarity = (sharedKeyValue / tokenCount) * 100;
    tt.rarity_score = tokenCount / sharedKeyValue;

    const valuesCountForTrait = new Set(sharedKey.map((item) => item.value))
      .size;

    tt.rarity_score_normalised =
      ((1 / sharedKey.length) * 1000000) /
      ((traitsCount + 1) * valuesCountForTrait + 1);
  });

  await persistNextGenTraits(entityManager, tokenTraits);
  await processTokenRarityScores(entityManager, collection);
}

async function processTokenRarityScores(
  entityManager: EntityManager,
  collection: NextGenCollection
) {
  const tokens = await fetchNextGenTokensForCollection(
    entityManager,
    collection
  );

  for (const token of tokens) {
    const traits = await entityManager.getRepository(NextGenTokenTrait).find({
      where: {
        token_id: token.id
      }
    });

    const { rarityScore, rarityScoreNormalised } = traits.reduce(
      (acc, tt) => {
        acc.rarityScore += tt.rarity_score;
        acc.rarityScoreNormalised += tt.rarity_score_normalised;
        return acc;
      },
      { rarityScore: 0, rarityScoreNormalised: 0 }
    );

    token.rarity_score = rarityScore;
    token.rarity_score_normalised = rarityScoreNormalised;
  }

  await entityManager.getRepository(NextGenToken).save(tokens);
}
