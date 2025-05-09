import * as sentryContext from '../sentry.context';
import { Logger } from '../logging';
import { ActivityEventEntity } from '../entities/IActivityEvent';
import { IdentitySubscriptionEntity } from '../entities/IIdentitySubscription';
import { DataSource } from 'typeorm';
import { prepEnvironment } from '../env';
import { WaveMetricEntity } from '../entities/IWaveMetric';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';
import { DropRelationEntity } from '../entities/IDropRelation';
import {
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropReferencedNftEntity
} from '../entities/IDrop';
import { DropVoteCreditSpending } from '../entities/IDropVoteCreditSpending';
import { DeletedDropEntity } from '../entities/IDeletedDrop';
import { WaveArchiveEntity, WaveEntity } from '../entities/IWave';
import { Profile, ProfileArchived } from '../entities/IProfile';
import { CicStatement } from '../entities/ICICStatement';
import { Rating } from '../entities/IRating';
import { RatingsSnapshot } from '../entities/IRatingsSnapshots';
import { ProfileActivityLog } from '../entities/IProfileActivityLog';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';
import { ProfileProxyEntity } from '../entities/IProfileProxy';
import { ProfileProxyActionEntity } from '../entities/IProfileProxyAction';
import { UserGroupEntity } from '../entities/IUserGroup';
import { AddressConsolidationKey } from '../entities/IAddressConsolidationKey';
import { IdentityEntity } from '../entities/IIdentity';
import { ProfileGroupEntity } from '../entities/IProfileGroup';
import { CookiesConsent } from '../entities/ICookieConsent';
import { Prenode } from '../entities/IPrenode';
import { ProfileLatestLogEntity } from '../entities/IProfileLatestLog';
import { WaveDropperMetricEntity } from '../entities/IWaveDropperMetric';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { ClapCreditSpendingEntity } from '../entities/IClapCreditSpending';
import { DropClapperStateEntity } from '../entities/IDropClapperState';
import { DropVoterStateEntity } from '../entities/IDropVoterState';
import { DropRankEntity } from '../entities/IDropRank';
import { RefreshToken } from '../entities/IRefreshToken';
import { EULAConsent } from '../entities/IEULAPolicy';
import {
  WaveDecisionEntity,
  WaveDecisionWinnerDropEntity
} from '../entities/IWaveDecision';
import { WSConnectionEntity } from '../entities/IWSConnectionEntity';
import { DropRealVoteInTimeEntity } from '../entities/IDropRealVoteInTime';
import { WaveLeaderboardEntryEntity } from '../entities/IWaveLeaderboardEntry';
import { WinnerDropVoterVoteEntity } from '../entities/IWinnerDropVoterVote';
import { DropRealVoterVoteInTimeEntity } from '../entities/IDropRealVoterVoteInTime';

const DBMigrate = require('db-migrate');

const logger = Logger.get('DB_MIGRATIONS_LOOP');

const MANAGED_ENTITIES = [
  AbusivenessDetectionResult,
  ActivityEventEntity,
  AddressConsolidationKey,
  CicStatement,
  CookiesConsent,
  DeletedDropEntity,
  DropEntity,
  DropMediaEntity,
  DropMentionEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropReferencedNftEntity,
  DropRelationEntity,
  DropVoteCreditSpending,
  DropRealVoteInTimeEntity,
  DropRealVoterVoteInTimeEntity,
  ClapCreditSpendingEntity,
  IdentityEntity,
  IdentityNotificationEntity,
  IdentitySubscriptionEntity,
  Prenode,
  Profile,
  ProfileActivityLog,
  ProfileArchived,
  ProfileArchived,
  ProfileGroupEntity,
  ProfileProxyActionEntity,
  ProfileProxyEntity,
  ProfileLatestLogEntity,
  Rating,
  RatingsSnapshot,
  UserGroupEntity,
  WaveEntity,
  WaveArchiveEntity,
  WaveMetricEntity,
  WaveDropperMetricEntity,
  WaveLeaderboardEntryEntity,
  WaveDecisionEntity,
  WaveDecisionWinnerDropEntity,
  PushNotificationDevice,
  DropClapperStateEntity,
  DropVoterStateEntity,
  DropRankEntity,
  RefreshToken,
  EULAConsent,
  WSConnectionEntity,
  WinnerDropVoterVoteEntity
];

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await prepEnvironment();
  const ormDs = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT!),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    entities: MANAGED_ENTITIES,
    synchronize: true,
    logging: false
  });
  try {
    await ormDs
      .initialize()
      .catch((error) => logger.error(`DB INIT ERROR: ${error}`));

    const dbmigrate = await DBMigrate.getInstance(true, {
      config: './database.json',
      env: 'main'
    });
    await dbmigrate.up();
  } finally {
    await ormDs.destroy();
  }
  logger.info(`[FINISHED]`);
});
