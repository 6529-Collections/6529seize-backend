import {
  fetchNextGenCollections,
  fetchNextGenTokenTraits,
  persistNextGenTraits
} from '../db';
import { NextGenCollection, NextGenTokenTrait } from '../entities/INextGen';
import { Logger } from '../logging';

const logger = Logger.get('NEXTGEN_TRAITS');

export async function processTraitScores() {
  const collections = await fetchNextGenCollections();
  const tokenTraits = await fetchNextGenTokenTraits();
  for (const collection of collections) {
    const collectionTokenTraits = tokenTraits.filter(
      (tt) => tt.collection_id === collection.id
    );
    await processCollectionTraitScores(collection, collectionTokenTraits);
  }
}

async function processCollectionTraitScores(
  collection: NextGenCollection,
  tokenTraits: NextGenTokenTrait[]
) {
  logger.info(`[PROCESSING TRAIT SCORES] : [COLLECTION ${collection.id}]`);
  tokenTraits.forEach((tt) => {
    const name = tt.trait;
    const value = tt.value;

    const traitScore = tokenTraits.filter((tt) => tt.trait === name).length;

    const valueScore = tokenTraits.filter(
      (tt) => tt.trait === name && tt.value === value
    ).length;

    tt.trait_score = traitScore;
    tt.value_score = valueScore;
  });

  await persistNextGenTraits([], tokenTraits);
}
