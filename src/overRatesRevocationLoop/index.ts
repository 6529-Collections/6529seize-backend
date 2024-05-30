import { loadEnv, unload } from '../secrets';
import { Profile, ProfileArchived } from '../entities/IProfile';
import { Logger } from '../logging';
import { CicStatement } from '../entities/ICICStatement';
import { ProfileActivityLog } from '../entities/IProfileActivityLog';
import { Rating } from '../entities/IRating';
import { ratingsService } from '../rates/ratings.service';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';
import * as sentryContext from '../sentry.context';
import { CommunityGroupEntity } from '../entities/ICommunityGroup';
import { RatingsSnapshot } from '../entities/IRatingsSnapshots';
import {
  DropCommentEntity,
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropReferencedNftEntity
} from '../entities/IDrop';
import { DropVoteChange } from '../entities/IDropVoteChange';
import { ProfileProxyEntity } from '../entities/IProfileProxy';
import { ProfileProxyActionEntity } from '../entities/IProfileProxyAction';
import { WaveEntity } from '../entities/IWave';
import { DropVoteEntity } from '../entities/IDropVote';
import { CookiesConsent } from '../entities/ICookieConsent';

const logger = Logger.get('OVER_RATES_REVOCATION_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([
    Profile,
    ProfileArchived,
    CicStatement,
    ProfileActivityLog,
    Rating,
    AbusivenessDetectionResult,
    RatingsSnapshot,
    DropEntity,
    DropPartEntity,
    DropMentionEntity,
    DropReferencedNftEntity,
    DropMetadataEntity,
    DropMediaEntity,
    DropVoteChange,
    DropCommentEntity,
    ProfileProxyEntity,
    ProfileProxyActionEntity,
    WaveEntity,
    CommunityGroupEntity,
    DropVoteEntity,
    CookiesConsent
  ]);
  await ratingsService.reduceOverRates();
  await unload();
  logger.info(`[COMPLETE]`);
});
