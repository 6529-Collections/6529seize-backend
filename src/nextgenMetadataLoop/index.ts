import { Logger } from '../logging';
import { Time } from '../time';
import { loadEnv } from '../secrets';
import { NextGenToken, NextGenTokenTrait } from '../entities/INextGen';
import { refreshNextgenMetadata } from '../nextgen/nextgen_metadata_refresh';

const logger = Logger.get('NEXTGEN');

export const handler = async (event: any) => {
  const start = Time.now();
  logger.info(`[RUNNING]`);
  await loadEnv([NextGenToken, NextGenTokenTrait]);
  await refreshNextgenMetadata();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};
