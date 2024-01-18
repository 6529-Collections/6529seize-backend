import {
  fetchNextGenCollections,
  persistNextGenTraits,
  fetchNextGenTokenTraits
} from './nextgen.db';
import { NextGenCollection, NextGenTokenTrait } from '../entities/INextGen';
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
  logger.info(`[PROCESSING TRAIT SCORES] : [COLLECTION ${collection.id}]`);
  tokenTraits.forEach((tt) => {
    const name = tt.trait;
    const value = tt.value;

    const valueScore = tokenTraits.filter(
      (tt) => tt.trait === name && tt.value === value
    ).length;

    tt.value_score = valueScore;
    tt.trait_score = collection.mint_count;
  });

  await persistNextGenTraits(entityManager, tokenTraits);
}
