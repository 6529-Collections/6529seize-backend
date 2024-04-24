import { loadEnv, unload } from '../secrets';
import { Profile, ProfileArchived } from '../entities/IProfile';
import { Logger } from '../logging';
import { CicStatement } from '../entities/ICICStatement';
import { ProfileActivityLog } from '../entities/IProfileActivityLog';
import { Rating } from '../entities/IRating';
import { ratingsService } from '../rates/ratings.service';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';
import * as sentryContext from '../sentry.context';
import { CommunityMembersCurationCriteriaEntity } from '../entities/ICommunityMembersCurationCriteriaEntity';
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
import { DropVoteCreditSpending } from '../entities/IDropVoteCreditSpending';
import { dropOverRaterRevocationService } from '../drops/drop-over-rater-revocation.service';

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
    CommunityMembersCurationCriteriaEntity,
    RatingsSnapshot,
    DropEntity,
    DropPartEntity,
    DropMentionEntity,
    DropReferencedNftEntity,
    DropMetadataEntity,
    DropMediaEntity,
    DropVoteCreditSpending,
    DropCommentEntity
  ]);
  await ratingsService.reduceOverRates();
  await dropOverRaterRevocationService.revokeOverRates();
  await unload();
  logger.info(`[COMPLETE]`);
});
