import { Logger } from './logging';
import { Time } from './time';
import { loadEnv } from './secrets';
import {
  Drop,
  DropMentionEntity,
  DropMetadataEntity,
  DropReferencedNftEntity
} from './entities/IDrop';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await loadEnv([
    Drop,
    DropMentionEntity,
    DropReferencedNftEntity,
    DropMetadataEntity
  ]);

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
