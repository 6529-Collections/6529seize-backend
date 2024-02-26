import { ethers } from 'ethers';
import {
  persistNextGenToken,
  fetchMissingMintDataNextgenTokens,
  persistNextGenTraits
} from './nextgen.db';
import { Logger } from '../logging';
import { EntityManager } from 'typeorm';
import {
  MINT_TYPE_TRAIT,
  NEXTGEN_CORE_CONTRACT,
  getNextgenNetwork
} from './nextgen_constants';
import { capitalizeEveryWord, getRpcUrlFromNetwork } from '../helpers';
import { NEXTGEN_CORE_ABI } from '../abis/nextgen';
import { NextGenTokenTrait } from '../entities/INextGen';

const logger = Logger.get('NEXTGEN_PENDING_MINT_DATA');

export async function processMissingMintData(entityManager: EntityManager) {
  const missingData = await fetchMissingMintDataNextgenTokens(entityManager);

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
          rarity_score: -1,
          rarity_score_rank: -1,
          rarity_score_normalised: -1,
          rarity_score_normalised_rank: -1,
          rarity_score_trait_count_normalised: -1,
          rarity_score_trait_count_normalised_rank: -1,
          statistical_rarity: -1,
          statistical_rarity_rank: -1,
          statistical_rarity_normalised: -1,
          statistical_rarity_normalised_rank: -1,
          single_trait_rarity_score_normalised: -1,
          single_trait_rarity_score_normalised_rank: -1,
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
