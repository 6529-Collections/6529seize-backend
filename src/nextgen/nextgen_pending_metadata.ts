import {
  fetchNextGenCollections,
  persistNextGenToken,
  fetchPendingNextgenTokens
} from './nextgen.db';
import { Logger } from '../logging';
import {
  fetchNextGenMetadata,
  getRequiredMetadataName
} from '@/nextgen/nextgen-metadata';
import { processTraits } from './nextgen_core_events';
import { EntityManager } from 'typeorm';

const logger = Logger.get('NEXTGEN_PENDING_METADATA');

export async function processPendingMetadataTokens(
  entityManager: EntityManager
) {
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
      const metadataResponse: any = await fetchNextGenMetadata(metadataLink);
      const metadataName = getRequiredMetadataName(
        metadataResponse,
        metadataLink
      );

      const isPending = metadataName.toLowerCase().startsWith('pending');

      token.name = metadataName;
      token.metadata_url = metadataLink;
      token.image_url = metadataResponse.image;
      token.animation_url = metadataResponse.animation_url;
      token.generator = metadataResponse.generator;
      token.pending = isPending;

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
        `[TOKEN ID ${token.id}] : [PENDING ${isPending}] : [METADATA LINK ${metadataLink}]`
      );
    } catch (e) {
      logger.info(
        `[TOKEN ID ${token.id}] : [ERROR FETCHING METADATA] : [METADATA LINK ${metadataLink}] : [ERROR ${e}]`
      );
    }
  }
}
