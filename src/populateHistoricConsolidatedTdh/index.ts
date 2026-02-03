import { getAlchemyInstance } from '../alchemy';
import { WALLETS_TDH_TABLE } from '@/constants';
import {
  getDataSource,
  persistHistoricConsolidatedTDH,
  persistTDHBlock
} from '../db';
import { MemesSeason } from '../entities/ISeason';
import {
  ConsolidatedTDH,
  HistoricConsolidatedTDH,
  TDHBlock
} from '../entities/ITDH';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { sqlExecutor } from '../sql-executor';
import { consolidateTDH } from '../tdhLoop/tdh_consolidation';
import { uploadTDH } from '../tdhLoop/tdh_upload';

const logger = Logger.get('POPULATE_HISTORIC_CONSOLIDATED_TDH');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await doInDbContext(
    async () => {
      await populate();
    },
    {
      logger,
      entities: [
        HistoricConsolidatedTDH,
        MemesSeason,
        TDHBlock,
        ConsolidatedTDH
      ]
    }
  );

  logger.info(`[FINISHED]`);
});

async function populate() {
  const alchemy = getAlchemyInstance();

  const iterations = Number.parseInt(
    process.env.HISTORIC_CONSOLIDATED_TDH_ITERATIONS ?? '1'
  );
  const shouldUpload = process.env.HISTORIC_CONSOLIDATED_TDH_UPLOAD === 'true';

  logger.info(`[ITERATIONS=${iterations} - WILL UPLOAD=${shouldUpload}]`);

  const tdhBlocks: { block: number }[] = await sqlExecutor.execute(
    `SELECT distinct block FROM ${WALLETS_TDH_TABLE} order by block DESC limit ${iterations}`
  );

  tdhBlocks.reverse();

  logger.info(`[TDH BLOCKS count ${tdhBlocks.length}]`);

  for (let i = 0; i < tdhBlocks.length; i++) {
    logger.info(`[PROCESSING BLOCK ${i + 1}/${tdhBlocks.length}]`);
    const tdhBlock = tdhBlocks[i].block;
    const blockTimestamp = new Date(
      (await alchemy.core.getBlock(tdhBlock)).timestamp * 1000
    );
    logger.info(
      `[BLOCK ${tdhBlock}] [TIMESTAMP ${blockTimestamp.toUTCString()}]`
    );

    const { consolidatedTdh } = await consolidateTDH(tdhBlock, blockTimestamp);
    const entityManager = getDataSource().manager;
    await persistHistoricConsolidatedTDH(
      entityManager,
      tdhBlock,
      consolidatedTdh
    );
    await persistTDHBlock(tdhBlock, blockTimestamp, consolidatedTdh);

    logger.info(`[ENTRIES ${consolidatedTdh.length}]`);

    if (shouldUpload) {
      logger.info(`[UPLOADING...]`);
      const url = await uploadTDH(
        tdhBlock,
        blockTimestamp,
        consolidatedTdh,
        true,
        false
      );
      logger.info(`[UPLOAD URL ${url}]`);
    } else {
      logger.info('SKIPPING UPLOAD');
    }
  }
}
