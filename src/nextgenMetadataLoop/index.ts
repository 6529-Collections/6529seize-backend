import { Logger } from '../logging';
import { Time } from '../time';
import { loadEnv } from '../secrets';
import {
  NextGenCollection,
  NextGenToken,
  NextGenTokenTrait,
  NextGenTokenScore
} from '../entities/INextGen';
import { refreshNextgenMetadata } from '../nextgen/nextgen_metadata_refresh';

const logger = Logger.get('NEXTGEN_METADATA_LOOP');

export const handler = async (event: any) => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  await loadEnv([
    NextGenCollection,
    NextGenToken,
    NextGenTokenTrait,
    NextGenTokenScore
  ]);
  await refreshNextgenMetadata();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};
