import { DISTRIBUTION_NORMALIZED_TABLE } from '../constants';
import { getDataSource } from '../db';
import { Logger } from '../logging';
import { sqlExecutor } from '../sql-executor';
import { BaseNFT } from '../entities/INFT';
const logger = Logger.get('NFT_DISTRIBUTION');

export async function updateDistributionInfoFor<T extends BaseNFT>(
  entityClass: new () => T,
  table: string = DISTRIBUTION_NORMALIZED_TABLE
) {
  const missingInfo: { contract: string; card_id: number }[] =
    await getDataSource().manager.query(
      `SELECT DISTINCT contract, card_id
     FROM ${table}
     WHERE card_name IS NULL
        OR card_name = ''
        OR mint_date IS NULL`
    );

  if (missingInfo.length === 0) {
    logger.info(`[NO MISSING DISTRIBUTION INFO for ${entityClass.name}]`);
    return;
  }

  logger.info(
    `[${entityClass.name}] Missing info count: ${missingInfo.length}]`
  );

  const repo = getDataSource().getRepository(entityClass);

  for (const { contract, card_id } of missingInfo) {
    const nft = await repo.findOneBy({ contract, id: card_id } as any);

    if (nft) {
      const mintDate = nft.mint_date
        ? new Date(nft.mint_date).toISOString().slice(0, 19).replace('T', ' ')
        : null;

      await sqlExecutor.execute(
        `UPDATE ${table}
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
