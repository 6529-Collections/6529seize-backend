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
import { Time } from '../../../time';
import {
  xTdhRepository,
  XTdhRepository
} from '../../../tdh-grants/xtdh.repository';

export class TdhStatsService {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly identitiesDb: IdentitiesDb,
    private readonly tdhStatsRepository: TdhStatsRepository,
    private readonly tdhGrantsRepository: TdhGrantsRepository,
    private readonly xTdhRepository: XTdhRepository
  ) {}

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
    const now = Time.now();
    const dayLater = now.plusDays(1);
    const slot = await this.xTdhRepository.getActiveStatsSlot(ctx);
    const [
      grantedTargetCollectionsCount,
      grantedTargetTokensCount,
      grantedXTdhPerDay,
      spentGrantRate,
      incomingXTdhRate
    ] = await Promise.all([
      this.tdhStatsRepository.getGrantedTdhCollectionsCount(identityId, ctx),
      this.tdhStatsRepository.getGrantedTdhTokensCount(identityId, ctx),
      this.tdhStatsRepository.getGrantedTdhTotalSumPerDay(identityId, ctx),
      this.tdhGrantsRepository.getGrantorsMaxSpentTdhRateInTimeSpan(
        {
          grantorId: identityId,
          validFrom: now.toMillis(),
          validTo: dayLater.toMillis()
        },
        ctx
      ),
      this.tdhStatsRepository.getIncomingXTdhRate({ identityId, slot }, ctx)
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
      available_grant_rate:
        identityEntity.basetdh_rate * X_TDH_COEFFICIENT - spentGrantRate,
      received_xtdh_rate: incomingXTdhRate
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
