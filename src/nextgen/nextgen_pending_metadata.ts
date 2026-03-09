import {
  fetchNextGenCollections,
  persistNextGenToken,
  fetchPendingNextgenTokens
} from './nextgen.db';
import { Logger } from '../logging';
import {
  getPayloadPreview,
  normalizeMetadataPayload
} from '@/metadata-payload';
import { processTraits } from './nextgen_core_events';
import { EntityManager } from 'typeorm';

const logger = Logger.get('NEXTGEN_PENDING_METADATA');

async function fetchPendingTokenMetadata(
  metadataLink: string
): Promise<Record<string, unknown>> {
  const res = await fetch(metadataLink);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `Metadata fetch failed for ${metadataLink} with status ${res.status}`
    );
  }

  const metadata = normalizeMetadataPayload(body);
  if (!metadata) {
    const contentType = res.headers.get('content-type') ?? 'unknown';
    const preview = getPayloadPreview(body);
    throw new Error(
      `Invalid metadata payload for ${metadataLink} (content-type: ${contentType}, preview: ${preview})`
    );
  }
  return metadata;
}

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
      const metadataResponse: any =
        await fetchPendingTokenMetadata(metadataLink);
      const metadataName = metadataResponse.name;
      if (typeof metadataName !== 'string') {
        throw new Error(`Invalid metadata.name for ${metadataLink}`);
      }

      const pending = metadataName.toLowerCase().startsWith('pending');

      token.name = metadataName;
      token.metadata_url = metadataLink;
      token.image_url = metadataResponse.image;
      token.animation_url = metadataResponse.animation_url;
      token.generator = metadataResponse.generator;
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
