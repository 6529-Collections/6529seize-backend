import { RequestContext } from '../../../request.context';
import { ApiTdhStats } from '../generated/models/ApiTdhStats';
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import { NotFoundException } from '../../../exceptions';
import { tdhStatsRepository, TdhStatsRepository } from './tdh-stats.repository';
import { X_TDH_COEFFICIENT } from '../../../constants';
import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import {
  tdhGrantsRepository,
  TdhGrantsRepository
} from '../../../tdh-grants/tdh-grants.repository';
import {
  xTdhRepository,
  XTdhRepository
} from '../../../tdh-grants/xtdh.repository';
import { ApiTdhGlobalStats } from '../generated/models/ApiTdhGlobalStats';

export class TdhStatsService {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly identitiesDb: IdentitiesDb,
    private readonly tdhStatsRepository: TdhStatsRepository,
    private readonly tdhGrantsRepository: TdhGrantsRepository,
    private readonly xTdhRepository: XTdhRepository
  ) {}

  async getGlobalStats(ctx: RequestContext): Promise<ApiTdhGlobalStats> {
    const slot = await this.xTdhRepository.getActiveStatsSlot(ctx);
    const [
      identityStats,
      grantedTargetCollectionsCount,
      grantedTargetTokensCount,
      grantedXTdhTotalSum,
      grantedXTdhRate
    ] = await Promise.all([
      this.tdhStatsRepository.getGlobalIdentityStats(ctx),
      this.tdhStatsRepository.getGrantedTdhCollectionsGlobalCount(
        { slot },
        ctx
      ),
      this.tdhStatsRepository.getGrantedTdhTokensGlobalCount({ slot }, ctx),
      this.tdhStatsRepository.getGrantedTdhTotalSumPerDayGlobal({ slot }, ctx),
      this.tdhStatsRepository.getGrantedXTdhRateGlobal({ slot }, ctx)
    ]);
    return {
      tdh_rate: identityStats.tdh_rate,
      xtdh: identityStats.xtdh,
      granted_xtdh: grantedXTdhTotalSum,
      xtdh_multiplier: X_TDH_COEFFICIENT,
      xtdh_rate: identityStats.xtdh_rate,
      tdh: identityStats.tdh,
      granted_xtdh_rate: grantedXTdhRate,
      granted_target_collections_count: grantedTargetCollectionsCount,
      granted_target_tokens_count: grantedTargetTokensCount
    };
  }

  async getIdentityStats(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiTdhStats> {
    const identity =
      await this.identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey },
        ctx
      );
    const identityId = identity?.id;
    if (!identityId) {
      throw new NotFoundException(`Identity ${identityKey} not found`);
    }
    const identityEntity = (await this.identitiesDb.getIdentityByProfileId(
      identityId,
      ctx.connection
    ))!;
    const slot = await this.xTdhRepository.getActiveStatsSlot(ctx);
    const [
      grantedTargetCollectionsCount,
      grantedTargetTokensCount,
      grantedXTdhPerDay,
      incomingXTdhRate,
      spentXTdhRate
    ] = await Promise.all([
      this.tdhStatsRepository.getGrantedTdhCollectionsCount(
        { id: identityId, slot },
        ctx
      ),
      this.tdhStatsRepository.getGrantedTdhTokensCount(
        { id: identityId, slot },
        ctx
      ),
      this.tdhStatsRepository.getGrantedTdhTotalSumPerDay(
        { id: identityId, slot },
        ctx
      ),
      this.tdhStatsRepository.getIncomingXTdhRate({ identityId, slot }, ctx),
      this.tdhGrantsRepository.getGrantorsLooseSpentTdhRate(identityId, ctx)
    ]);
    return {
      identity,
      tdh_rate: identityEntity.basetdh_rate,
      xtdh: identityEntity.xtdh,
      granted_xtdh: identityEntity.granted_xtdh,
      received_xtdh:
        identityEntity.xtdh -
        (identityEntity.produced_xtdh - identityEntity.granted_xtdh),
      xtdh_multiplier: X_TDH_COEFFICIENT,
      xtdh_rate: identityEntity.xtdh_rate,
      tdh: identityEntity.tdh,
      granted_xtdh_rate: grantedXTdhPerDay,
      granted_target_collections_count: grantedTargetCollectionsCount,
      granted_target_tokens_count: grantedTargetTokensCount,
      available_grant_rate: Math.max(
        identityEntity.basetdh_rate * X_TDH_COEFFICIENT - spentXTdhRate,
        0
      ),
      received_xtdh_rate: incomingXTdhRate,
      produced_xtdh: identityEntity.produced_xtdh,
      produced_xtdh_rate: identityEntity.basetdh_rate * X_TDH_COEFFICIENT
    };
  }
}

export const tdhStatsService = new TdhStatsService(
  identityFetcher,
  identitiesDb,
  tdhStatsRepository,
  tdhGrantsRepository,
  xTdhRepository
);
