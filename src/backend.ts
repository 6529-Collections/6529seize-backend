import { Logger } from './logging';
import { Time } from './time';
import { loadEnv } from './secrets';
import {
  DropCommentEntity,
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropReferencedNftEntity
} from './entities/IDrop';
import { DropVoteCreditSpending } from './entities/IDropVoteCreditSpending';
import * as nfts from './nftsLoop';
import * as tdh from './tdhLoop';
import * as nftOwners from './nftOwnersLoop';
import * as ownersBalances from './ownersBalancesLoop';
import * as aggregatedActivity from './aggregatedActivityLoop';
import * as transactions from './transactionsLoop';
import * as delegations from './delegationsLoop';
import * as overRatesRevocationLoop from './overRatesRevocationLoop';
import * as customReplay from './customReplayLoop';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  // await transactions.handler(null, null as any, null as any);

  // await nfts.handler(null, null as any, null as any);
  // await nftOwners.handler(null, null as any, null as any);
  // await nfts.handler(null, null as any, null as any);
  // await ownersBalances.handler(null, null as any, null as any);
  // await aggregatedActivity.handler(null, null as any, null as any);

  // await tdh.handler(null, null as any, null as any);
  // await delegations.handler(null, null as any, null as any);

  await customReplay.handler(null, null as any, null as any);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
