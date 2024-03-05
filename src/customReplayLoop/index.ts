import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { getDataSource } from '../db';
import {
  NextGenCollection,
  NextGenLog,
  NextGenToken,
  NextGenTokenTrait
} from '../entities/INextGen';
import { NEXTGEN_CORE_IFACE, NEXTGEN_MINTER_IFACE } from '../abis/nextgen';
import { persistNextGenLogs } from '../nextgen/nextgen.db';
import {
  NEXTGEN_CORE_CONTRACT,
  getNextgenNetwork
} from '../nextgen/nextgen_constants';
import { processLog as processMinterLog } from '../nextgen/nextgen_minter';
import { processLog as processEventLog } from '../nextgen/nextgen_core_events';
import { processLog as processTransactionLog } from '../nextgen/nextgen_core_transactions';
import { getAlchemyInstance } from '../alchemy';
import { Transaction } from '../entities/ITransaction';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([
    NextGenLog,
    NextGenCollection,
    NextGenToken,
    NextGenTokenTrait,
    Transaction
  ]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  const dataSource = getDataSource();
  await dataSource.transaction(async (entityManager) => {
    const allNextgenLogs = await entityManager.getRepository(NextGenLog).find();

    const logsTokenIdNull = allNextgenLogs.filter(
      (log) => log.token_id === null
    );

    const logsTokenIdNotNull = allNextgenLogs.filter(
      (log) => log.token_id !== null
    );

    logger.info(
      `[FOUND ${allNextgenLogs.length} LOGS] : [NULL TOKEN_ID ${logsTokenIdNull.length}] : [NOT NULL TOKEN_ID ${logsTokenIdNotNull.length}]`
    );

    const network = getNextgenNetwork();
    const alchemy = getAlchemyInstance(network);

    const newLogs: NextGenLog[] = [];

    const minter = logsTokenIdNull.filter((log) => log.source === 'minter');
    const processedMinter = new Set<string>();
    for (const log of minter) {
      if (processedMinter.has(log.transaction)) {
        continue;
      }
      const receipt = await alchemy.core.getTransaction(log.transaction);
      if (receipt) {
        const parsedReceipt = NEXTGEN_MINTER_IFACE.parseTransaction({
          data: receipt.data,
          value: 0
        });
        const methodName = parsedReceipt.name;
        const args = parsedReceipt.args;
        const processedLogs = await processMinterLog(
          entityManager,
          methodName,
          args
        );
        processedLogs.forEach((processedLog, index) => {
          const l: NextGenLog = {
            id: `${log.transaction}-${index}`,
            transaction: log.transaction,
            block: log.block,
            block_timestamp: log.block_timestamp,
            collection_id: processedLog.id,
            heading: processedLog.title,
            log: processedLog.description,
            source: 'minter'
          };
          newLogs.push(l);
        });
        processedMinter.add(log.transaction);
      }
    }

    const events = logsTokenIdNull.filter((log) => log.source === 'events');
    const processedEvents = new Set<string>();
    for (const log of events) {
      if (processedEvents.has(log.transaction)) {
        continue;
      }
      const alchemyLog = await alchemy.core.getLogs({
        fromBlock: log.block,
        toBlock: log.block,
        address: NEXTGEN_CORE_CONTRACT[network]
      });
      for (const log of alchemyLog) {
        const processedLog = await processEventLog(entityManager, log);
        if (processedLog) {
          const blockTimestamp = (await alchemy.core.getBlock(log.blockNumber))
            .timestamp;
          const l: NextGenLog = {
            id: `${log.transactionHash}-${log.logIndex}`,
            transaction: log.transactionHash,
            block: log.blockNumber,
            block_timestamp: blockTimestamp,
            collection_id: processedLog.id,
            heading: processedLog.title,
            log: processedLog.description,
            source: 'events'
          };
          if (processedLog.token_id) {
            l.token_id = processedLog.token_id;
          }
          newLogs.push(l);
        }
      }
      processedEvents.add(log.transaction);
    }

    const transactions = logsTokenIdNull.filter(
      (log) => log.source === 'transactions'
    );
    const processedTransactions = new Set<string>();
    for (const log of transactions) {
      if (processedTransactions.has(log.transaction)) {
        continue;
      }
      const receipt = await alchemy.core.getTransaction(log.transaction);
      if (receipt) {
        const parsedReceipt = NEXTGEN_CORE_IFACE.parseTransaction({
          data: receipt.data,
          value: 0
        });
        const methodName = parsedReceipt.name;
        const args = parsedReceipt.args;
        const processedLogs = await processTransactionLog(
          entityManager,
          methodName,
          args
        );
        processedLogs.forEach((processedLog, index) => {
          const l: NextGenLog = {
            id: `${log.transaction}-${index}`,
            transaction: log.transaction,
            block: log.block,
            block_timestamp: log.block_timestamp,
            collection_id: processedLog.id,
            heading: processedLog.title,
            log: processedLog.description,
            source: 'transactions'
          };
          if (processedLog.token_id) {
            l.token_id = processedLog.token_id;
          }
          newLogs.push(l);
        });
      }
      processedTransactions.add(log.transaction);
    }

    logsTokenIdNotNull.forEach((log) => {
      log.heading = log.log;
      newLogs.push(log);
    });

    await entityManager.getRepository(NextGenLog).clear();
    await persistNextGenLogs(entityManager, newLogs);

    logger.info(`[NEW LOGS PERSISTED ${newLogs.length}]`);
  });
}
