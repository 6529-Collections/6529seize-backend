import {
  fetchNextGenCollections,
  persistNextGenToken,
  fetchPendingNextgenTokens
} from './nextgen.db';
import { Logger } from '../logging';
import { processTraits } from './nextgen_core_events';
import { EntityManager } from 'typeorm';

const logger = Logger.get('NEXTGEN_PENDING');

export async function processPendingTokens(entityManager: EntityManager) {
  const pending = await fetchPendingNextgenTokens(entityManager);
  const collections = await fetchNextGenCollections(entityManager);

  logger.info(`[FOUND ${pending.length} PENDING TOKENS]`);

  for (const token of pending) {
    const collection = collections.find((c) => c.id === token.collection_id);
    if (!collection) {
      logger.info(`[TOKEN ID ${token.id}] : [COLLECTION NOT FOUND]`);
      continue;
    }
    const metadataLink = `${collection.base_uri}${token.id}`;
    try {
      const metadataResponse: any = await (await fetch(metadataLink)).json();
      const pending = metadataResponse.name.toLowerCase().startsWith('pending');

      token.name = metadataResponse.name;
      token.metadata_url = metadataLink;
      token.image_url = metadataResponse.image;
      token.animation_url = metadataResponse.animation_url;
      token.generator_url = metadataResponse.generator_url;
      token.pending = pending;

      await persistNextGenToken(entityManager, token);
      if (metadataResponse.attributes) {
        await processTraits(
          entityManager,
          token.id,
          collection.id,
          metadataResponse.attributes
        );
      }
      logger.info(
        `[TOKEN ID ${token.id}] : [PENDING ${pending}] : [METADATA LINK ${metadataLink}]`
      );
    } catch (e) {
      logger.info(
        `[TOKEN ID ${token.id}] : [ERROR FETCHING METADATA] : [METADATA LINK ${metadataLink}] : [ERROR ${e}]`
      );
    }
  }
}
