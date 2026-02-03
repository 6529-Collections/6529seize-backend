import { RequestContext } from '../../../../request.context';
import {
  identityFetcher,
  IdentityFetcher
} from '../../identities/identity.fetcher';
import { NotFoundException } from '../../../../exceptions';
import { X_TDH_COEFFICIENT } from '@/constants';
import {
  identitiesDb,
  IdentitiesDb
} from '../../../../identities/identities.db';
import {
  xTdhRepository,
  XTdhRepository
} from '../../../../xtdh/xtdh.repository';
import { ApiXTdhGlobalStats } from '../../generated/models/ApiXTdhGlobalStats';
import { ApiXTdhStats } from '../../generated/models/ApiXTdhStats';

export class XTdhStatsService {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly identitiesDb: IdentitiesDb,
    private readonly xTdhRepository: XTdhRepository
  ) {}

  async getGlobalStats(ctx: RequestContext): Promise<ApiXTdhGlobalStats> {
    const [
      identityStats,
      grantedTargetCollectionsCount,
      grantedTargetTokensCount,
      grantedXTdhTotalSum,
      grantedXTdhRate
    ] = await Promise.all([
      this.xTdhRepository.getGlobalIdentityStats(ctx),
      this.xTdhRepository.getGrantedTdhCollectionsGlobalCount(ctx),
      this.xTdhRepository.getGrantedTdhTokensGlobalCount(ctx),
      this.xTdhRepository.getGrantedTdhTotalSumPerDayGlobal(ctx),
      this.xTdhRepository.getGrantedXTdhRateGlobal(ctx)
    ]);
    return {
      multiplier: X_TDH_COEFFICIENT,
      xtdh: identityStats.xtdh,
      xtdh_rate: identityStats.xtdh_rate,
      outgoing_total: grantedXTdhTotalSum,
      outgoing_rate: grantedXTdhRate,
      outgoing_collections_count: grantedTargetCollectionsCount,
      outgoing_tokens_count: grantedTargetTokensCount
    };
  }

  async getIdentityStats(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiXTdhStats> {
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
    const [
      grantedTargetCollectionsCount,
      grantedTargetTokensCount,
      grantedXTdhPerDay,
      incomingXTdhRate,
      spentXTdhRate
    ] = await Promise.all([
      this.xTdhRepository.getGrantedTdhCollectionsCount(identityId, ctx),
      this.xTdhRepository.getGrantedTdhTokensCount(identityId, ctx),
      this.xTdhRepository.getGrantedTdhTotalSumPerDay(identityId, ctx),
      this.xTdhRepository.getIncomingXTdhRate(identityId, ctx),
      this.xTdhRepository.getGrantorsLooseSpentTdhRate(identityId, ctx)
    ]);
    return {
      identity,
      xtdh: identityEntity.xtdh,
      xtdh_rate: identityEntity.xtdh_rate,
      outgoing_total: identityEntity.granted_xtdh,
      outgoing_rate: grantedXTdhPerDay,
      outgoing_collections_count: grantedTargetCollectionsCount,
      outgoing_tokens_count: grantedTargetTokensCount,
      incoming_total:
        identityEntity.xtdh -
        (identityEntity.produced_xtdh - identityEntity.granted_xtdh),
      incoming_rate: incomingXTdhRate,
      multiplier: X_TDH_COEFFICIENT,
      generated_total: identityEntity.produced_xtdh,
      generation_rate: identityEntity.basetdh_rate * X_TDH_COEFFICIENT,
      unused_rate: Math.max(
        identityEntity.basetdh_rate * X_TDH_COEFFICIENT - spentXTdhRate,
        0
      )
    };
  }
}

export const xTdhStatsService = new XTdhStatsService(
  identityFetcher,
  identitiesDb,
  xTdhRepository
);
