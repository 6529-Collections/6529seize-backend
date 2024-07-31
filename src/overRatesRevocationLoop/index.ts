import { Profile, ProfileArchived } from '../entities/IProfile';
import { Logger } from '../logging';
import { CicStatement } from '../entities/ICICStatement';
import { ProfileActivityLog } from '../entities/IProfileActivityLog';
import { Rating } from '../entities/IRating';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';
import * as sentryContext from '../sentry.context';
import { UserGroupEntity } from '../entities/IUserGroup';
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
import { ProfileProxyEntity } from '../entities/IProfileProxy';
import { ProfileProxyActionEntity } from '../entities/IProfileProxyAction';
import { WaveEntity } from '../entities/IWave';
import { CookiesConsent } from '../entities/ICookieConsent';
import { IdentityEntity } from '../entities/IIdentity';
import { AddressConsolidationKey } from '../entities/IAddressConsolidationKey';
import { Prenode } from '../entities/IPrenode';
import { ProfileGroupEntity } from '../entities/IProfileGroup';
import { doInDbContext } from '../secrets';
import { ratingsService } from '../rates/ratings.service';
import { dropOverRaterRevocationService } from '../drops/drop-over-rater-revocation.service';

const logger = Logger.get('OVER_RATES_REVOCATION_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await ratingsService.reduceOverRates();
      await dropOverRaterRevocationService.revokeOverRates();
    },
    {
      logger,
      entities: [
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
        DropVoteCreditSpending,
        DropCommentEntity,
        ProfileProxyEntity,
        ProfileProxyActionEntity,
        WaveEntity,
        CookiesConsent,
        UserGroupEntity,
        AddressConsolidationKey,
        IdentityEntity,
        Prenode,
        ProfileGroupEntity
      ]
    }
  );
});
