import {
  DISTRIBUTION_NORMALIZED_TABLE,
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '../constants';
import { getDataSource } from '../db';
import { BaseNFT, LabNFT, NFT } from '../entities/INFT';
import { Logger } from '../logging';
import { sqlExecutor } from '../sql-executor';

const logger = Logger.get('NFT_DISTRIBUTION');

const CONTRACTS_BY_ENTITY: Record<string, string[]> = {
  [NFT.name]: [MEMES_CONTRACT, GRADIENT_CONTRACT],
  [LabNFT.name]: [MEMELAB_CONTRACT]
};

function getContractsForEntity<T extends BaseNFT>(
  entityClass: new () => T
): string[] {
  const contracts = CONTRACTS_BY_ENTITY[entityClass.name];
  if (!contracts) {
    throw new Error(`Unknown entity for distribution: ${entityClass.name}`);
  }
  return contracts;
}

export async function updateDistributionInfoFor<T extends BaseNFT>(
  entityClass: new () => T
) {
  const contracts = getContractsForEntity(entityClass);
  const repo = getDataSource().getRepository(entityClass);

  const missingInfo: { contract: string; card_id: number }[] =
    await getDataSource().manager.query(
      `SELECT DISTINCT contract, card_id
       FROM ${DISTRIBUTION_NORMALIZED_TABLE}
       WHERE is_missing_info = 1 AND contract IN (${contracts.map(() => '?').join(',')})`,
      contracts
    );

  if (missingInfo.length === 0) {
    logger.info(`[NO MISSING DISTRIBUTION INFO for ${entityClass.name}]`);
    return;
  }

  logger.info(
    `[${entityClass.name}] Missing info count: ${missingInfo.length}`
  );

  for (const { contract, card_id } of missingInfo) {
    const nft = await repo.findOneBy({ contract, id: card_id } as any);

    if (nft) {
      const mintDate = nft.mint_date
        ? new Date(nft.mint_date).toISOString().slice(0, 19).replace('T', ' ')
        : null;

      await sqlExecutor.execute(
        `UPDATE ${DISTRIBUTION_NORMALIZED_TABLE}
         SET card_name = :cardName, mint_date = :mintDate
         WHERE contract = :contract
         AND card_id = :cardId;`,
        {
          contract: nft.contract,
          cardId: nft.id,
          cardName: nft.name,
          mintDate
        }
      );
    }
  }
}
