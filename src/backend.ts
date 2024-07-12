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
import { dbSupplier } from './sql-executor';
import {
  syncIdentitiesMetrics,
  syncIdentitiesWithTdhConsolidations
} from './identity';

const logger = Logger.get('BACKEND');

async function start() {
  const start = Time.now();
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

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
    DropVoteCreditSpending,
    DropCommentEntity,
    ProfileProxyEntity,
    ProfileProxyActionEntity,
    WaveEntity,
    CookiesConsent,
    UserGroupEntity,
    AddressConsolidationKey,
    IdentityEntity,
    ProfileGroupEntity
  ]);
  await dbSupplier().executeNativeQueriesInTransaction(async (tx) => {
    await syncIdentitiesWithTdhConsolidations(tx);
    await syncIdentitiesMetrics(tx);
  });
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[START SCRIPT COMPLETE IN ${diff}]`);
  process.exit(0);
}

start();
