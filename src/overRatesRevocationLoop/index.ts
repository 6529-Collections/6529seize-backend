import { loadEnv, unload } from '../secrets';
import { Profile, ProfileArchived } from '../entities/IProfile';
import { Logger } from '../logging';
import { CicStatement } from '../entities/ICICStatement';
import { ProfileActivityLog } from '../entities/IProfileActivityLog';
import { Rating } from '../entities/IRating';
import { ratingsService } from '../rates/ratings.service';

const logger = Logger.get('OVER_RATES_REVOCATION_LOOP');

export const handler = async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([
    Profile,
    ProfileArchived,
    CicStatement,
    ProfileActivityLog,
    Rating
  ]);
  await ratingsService.reduceOverRates();
  await unload();
  logger.info(`[COMPLETE]`);
};
