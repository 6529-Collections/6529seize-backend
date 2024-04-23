import { Logger } from './logging';
import { Time } from './time';
import { loadEnv } from './secrets';
import {
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropReferencedNftEntity
} from './entities/IDrop';
import { DropVoteCreditSpending } from './entities/IDropVoteCreditSpending';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await loadEnv([
    DropEntity,
    DropMentionEntity,
    DropReferencedNftEntity,
    DropMetadataEntity,
    DropMediaEntity,
    DropVoteCreditSpending
  ]);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
