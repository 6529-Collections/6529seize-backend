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
import * as tdh from './tdhLoop';
import * as nfts from './nftsLoop';
import * as owners from './nftOwnersLoop';
import * as marketStats from './marketStatsLoop';

const logger = Logger.get('BACKEND');

async function start() {
  logger.info(`[CONFIG ${process.env.NODE_ENV}] [EXECUTING START SCRIPT...]`);

  await nfts.handler(null as any, null as any, null as any);
  await owners.handler(null as any, null as any, null as any);
  // await tdh.handler(null as any, null as any, null as any);
  await marketStats.handler(null as any, null as any, null as any);

  process.exit(0);
}

start();
