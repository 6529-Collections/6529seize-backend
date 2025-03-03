import { PageSortDirection } from '../page-request';
import { ApiWaveDecisionsPage } from '../generated/models/ApiWaveDecisionsPage';
import { RequestContext } from '../../../request.context';
import {
  waveDecisionsDb,
  WaveDecisionsDb
} from '../../../waves/wave-decisions.db';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { wavesApiDb, WavesApiDb } from './waves.api.db';
import { NotFoundException } from '../../../exceptions';
import { DropsApiService, dropsService } from '../drops/drops.api.service';
import { ApiWaveDecision } from '../generated/models/ApiWaveDecision';
import { ApiWaveDecisionAward } from '../generated/models/ApiWaveDecisionAward';

export class WaveDecisionsApiService {
  constructor(
    private readonly waveDecisionsDb: WaveDecisionsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly wavesApiDb: WavesApiDb,
    private readonly dropsApiService: DropsApiService
  ) {}

  public async searchConcludedWaveDecisions(
    query: WaveDecisionsQuery,
    ctx: RequestContext
  ): Promise<ApiWaveDecisionsPage> {
    ctx.timer?.start(`${this.constructor.name}->searchConcludedWaveDecisions`);
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        ctx.authenticationContext?.getActingAsId() ?? null,
        ctx.timer
      );
    const waveEntity = await this.wavesApiDb.findWaveById(
      query.wave_id,
      ctx.connection
    );
    if (!waveEntity) {
      throw new NotFoundException(`Wave not found`);
    }
    if (
      waveEntity.visibility_group_id !== null &&
      !groupsUserIsEligibleFor.includes(waveEntity.visibility_group_id)
    ) {
      throw new NotFoundException(`Wave not found`);
    }
    const [decisionEntities, count] = await Promise.all([
      this.waveDecisionsDb.searchForDecisions(
        {
          wave_id: query.wave_id,
          limit: query.page_size,
          offset: query.page_size * (query.page - 1),
          sort_direction: query.sort_direction,
          sort: query.sort
        },
        ctx
      ),
      this.waveDecisionsDb.countDecisions(query.wave_id, ctx)
    ]);
    const decisionWinners = await this.waveDecisionsDb.findAllDecisionWinners(
      decisionEntities,
      ctx
    );
    const winningDropIds = decisionWinners.map((it) => it.drop_id);
    const drops = await this.dropsApiService.findDropsByIds(
      winningDropIds,
      ctx.authenticationContext,
      ctx.connection
    );
    ctx.timer?.stop(`${this.constructor.name}->searchConcludedWaveDecisions`);
    return {
      page: query.page,
      next: false,
      count: count,
      data: decisionEntities.map<ApiWaveDecision>((decisionEntity) => {
        const winningEntities = decisionWinners.filter(
          (winner) => winner.decision_time === decisionEntity.decision_time
        );
        return {
          decision_time: decisionEntity.decision_time,
          winners: winningEntities.map((winner) => ({
            drop: drops[winner.drop_id],
            place: winner.ranking,
            awards: winner.prizes.map(
              (it) => it as unknown as ApiWaveDecisionAward
            )
          }))
        };
      })
    };
  }
}

export enum WaveDecisionsQuerySort {
  decision_time = 'decision_time'
}

export interface WaveDecisionsQuery {
  readonly wave_id: string;
  readonly page_size: number;
  readonly page: number;
  readonly sort_direction: PageSortDirection;
  readonly sort: string;
}

export const waveDecisionsApiService = new WaveDecisionsApiService(
  waveDecisionsDb,
  userGroupsService,
  wavesApiDb,
  dropsService
);
