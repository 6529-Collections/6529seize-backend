import { doInDbContext } from '../secrets';
import {
  LabExtendedData,
  LabNFT,
  MemesExtendedData,
  NFT
} from '../entities/INFT';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';
import { NFTOwner } from '../entities/INFTOwner';
import { getDataSource } from '../db';
import { DISTRIBUTION_NORMALIZED_TABLE } from '../constants';
import { sqlExecutor } from '../sql-executor';
import { NFT_MODE, processNFTs } from './nfts';
import { resolveEnumOrThrow } from '../helpers';
import {
  findMemesExtendedData,
  findMemeLabExtendedData
} from './nft_extended_data';
import { Transaction } from '../entities/ITransaction';
const logger = Logger.get('NFTS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  await doInDbContext(
    async () => {
      await nftsLoop(event?.mode);
    },
    {
      logger,
      entities: [
        NFT,
        MemesExtendedData,
        MemesSeason,
        NFTOwner,
        LabNFT,
        LabExtendedData,
        Transaction
      ]
    }
  );
});

async function nftsLoop(mode?: string) {
  const modeEnum = resolveEnumOrThrow(NFT_MODE, mode);
  await processNFTs(modeEnum);
  await findMemesExtendedData();
  await updateDistributionInfo();
  await findMemeLabExtendedData();
}

async function updateDistributionInfo() {
  const missingInfoDistributions: { contract: string; card_id: number }[] =
    await getDataSource().manager.query(
      `SELECT DISTINCT contract, card_id
        FROM (
          SELECT contract, card_id, 1 AS tag  FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE card_name IS NULL
        UNION ALL
        SELECT contract, card_id, 2 AS tag  FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE card_name = ''
        UNION ALL
        SELECT contract, card_id, 3 AS tag  FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE mint_date IS NULL
      ) AS u`
    );

  if (missingInfoDistributions.length === 0) {
    logger.info(`[NO MISSING DISTRIBUTION INFO]`);
    return;
  }

  logger.info(
    `[MISSING INFO DISTRIBUTIONS: ${missingInfoDistributions.length}]`
  );

  for (const distribution of missingInfoDistributions) {
    const nft = await getDataSource()
      .getRepository(NFT)
      .findOne({
        where: {
          contract: distribution.contract,
          id: distribution.card_id
        }
      });
    if (nft) {
      await sqlExecutor.execute(
        `UPDATE ${DISTRIBUTION_NORMALIZED_TABLE}
          SET card_name = :cardName, mint_date = :mintDate
          WHERE contract = :contract
          AND card_id = :cardId;`,
        {
          contract: distribution.contract,
          cardId: distribution.card_id,
          cardName: nft.name,
          mintDate: nft.mint_date
            ? new Date(nft.mint_date)
                .toISOString()
                .slice(0, 19)
                .replace('T', ' ')
            : null
        }
      );
    }
  }
}
