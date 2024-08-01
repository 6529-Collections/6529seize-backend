import { Logger } from './logging';
import { doInDbContext } from './secrets';
import {
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropReferencedNftEntity
} from './entities/IDrop';
import { DropVoteCreditSpending } from './entities/IDropVoteCreditSpending';
import { Profile, ProfileArchived } from './entities/IProfile';
import { CicStatement } from './entities/ICICStatement';
import { ProfileActivityLog } from './entities/IProfileActivityLog';
import { Rating } from './entities/IRating';
import { AbusivenessDetectionResult } from './entities/IAbusivenessDetectionResult';
import { UserGroupEntity } from './entities/IUserGroup';
import { RatingsSnapshot } from './entities/IRatingsSnapshots';
import { ProfileProxyEntity } from './entities/IProfileProxy';
import { ProfileProxyActionEntity } from './entities/IProfileProxyAction';
import { WaveEntity } from './entities/IWave';
import { CookiesConsent } from './entities/ICookieConsent';
import { AddressConsolidationKey } from './entities/IAddressConsolidationKey';
import { IdentityEntity } from './entities/IIdentity';
import { ProfileGroupEntity } from './entities/IProfileGroup';
import * as dbMigrationsLoop from './dbMigrationsLoop';

const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await doInDbContext(
    async () => {
      await dbMigrationsLoop.handler(
        undefined as any,
        undefined as any,
        undefined as any
      );
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
        ProfileProxyEntity,
        ProfileProxyActionEntity,
        WaveEntity,
        CookiesConsent,
        UserGroupEntity,
        AddressConsolidationKey,
        IdentityEntity,
        ProfileGroupEntity
      ]
    }
  );
  process.exit(0);
}

start();
