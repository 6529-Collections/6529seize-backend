import { ethers } from 'ethers';
import {
  fetchNextGenCollections,
  persistNextGenToken,
  fetchPendingNextgenTokens,
  fetchMissingDataNextgenTokens,
  persistNextGenTraits
} from './nextgen.db';
import { Logger } from '../logging';
import { processTraits } from './nextgen_core_events';
import { EntityManager } from 'typeorm';
import {
  MINT_TYPE_TRAIT,
  NEXTGEN_CORE_CONTRACT,
  getNextgenNetwork
} from './nextgen_constants';
import { capitalizeEveryWord, getRpcUrlFromNetwork } from '../helpers';
import { NEXTGEN_CORE_ABI } from '../abis/nextgen';
import { NextGenTokenTrait } from '../entities/INextGen';

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

export async function processMissingTokenData(entityManager: EntityManager) {
  const missingData = await fetchMissingDataNextgenTokens(entityManager);

  if (missingData.length === 0) {
    logger.info(`[NO MISSING TOKEN DATA]`);
    return;
  }

  logger.info(`[FOUND ${missingData.length} MISSING TOKEN DATA]`);

  const network = getNextgenNetwork();
  const rpcUrl = getRpcUrlFromNetwork(network);
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  const contract = new ethers.Contract(
    NEXTGEN_CORE_CONTRACT[network],
    NEXTGEN_CORE_ABI,
    provider
  );

  const newTraits: NextGenTokenTrait[] = [];

  for (const token of missingData) {
    try {
      const tokenData = await contract.functions.tokenData(token.id);
      logger.info(`[TOKEN ID ${token.id}] : [TOKEN DATA] : [${tokenData}]`);

      token.mint_data = tokenData;

      await persistNextGenToken(entityManager, token);

      const tokenDataObj = JSON.parse(tokenData);
      for (const key in tokenDataObj) {
        const newTrait = `${MINT_TYPE_TRAIT} - ${capitalizeEveryWord(key)}`;
        const newTraitValue = tokenDataObj[key];

        logger.info(
          `[TOKEN ID ${token.id}] : [NEW TRAIT] : [${newTrait}] : [${newTraitValue}]`
        );

        const tokenTrait: NextGenTokenTrait = {
          token_id: token.id,
          collection_id: token.collection_id,
          trait: newTrait,
          value: newTraitValue,
          statistical_rarity: 0,
          statistical_rarity_rank: 0,
          rarity_score: 0,
          rarity_score_rank: 0,
          rarity_score_normalised: 0,
          rarity_score_normalised_rank: 0,
          token_count: 0,
          trait_count: 0
        };
        newTraits.push(tokenTrait);
      }
    } catch (e) {
      logger.info(
        `[TOKEN ID ${token.id}] : [ERROR FETCHING TOKEN DATA] : [ERROR ${e}]`
      );
    }

    await persistNextGenTraits(entityManager, newTraits);
  }
}
