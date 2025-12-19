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
import { ApiWaveOutcomesPage } from '../generated/models/ApiWaveOutcomesPage';
import { ApiWaveOutcomeDistributionItemsPage } from '../generated/models/ApiWaveOutcomeDistributionItemsPage';
import { ApiWaveOutcome } from '../generated/models/ApiWaveOutcome';
import { enums } from '../../../enums';
import { ApiWaveOutcomeType } from '../generated/models/ApiWaveOutcomeType';
import { ApiWaveOutcomeSubType } from '../generated/models/ApiWaveOutcomeSubType';
import { ApiWaveOutcomeCredit } from '../generated/models/ApiWaveOutcomeCredit';
import { ApiWaveOutcomeDistributionItem } from '../generated/models/ApiWaveOutcomeDistributionItem';

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

  async getOutcomes(
    params: WaveOutcomesQuery,
    ctx: RequestContext
  ): Promise<ApiWaveOutcomesPage> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getOutcomes`);
      const waveEntity = await this.wavesApiDb.findWaveById(
        params.wave_id,
        ctx.connection
      );
      if (!waveEntity) {
        throw new NotFoundException(`Wave not found`);
      }
      const eligibleGroups =
        await this.userGroupsService.getGroupsUserIsEligibleFor(
          ctx.authenticationContext?.getActingAsId() ?? null,
          ctx.timer
        );
      if (
        waveEntity.visibility_group_id !== null &&
        !eligibleGroups.includes(waveEntity.visibility_group_id)
      ) {
        throw new NotFoundException(`Wave not found`);
      }
      const [data, count] = await Promise.all([
        this.wavesApiDb.findOutcomes(
          {
            wave_id: params.wave_id,
            limit: params.page_size,
            offset: params.page_size * (params.page - 1),
            order: params.sort_direction
          },
          ctx
        ),
        this.wavesApiDb.countOutcomes(
          {
            wave_id: params.wave_id
          },
          ctx
        )
      ]);
      return {
        page: params.page,
        count,
        data: data.map<ApiWaveOutcome>((outcome) => ({
          type: enums.resolve(ApiWaveOutcomeType, outcome.type)!,
          subtype: outcome.subtype
            ? enums.resolve(ApiWaveOutcomeSubType, outcome.subtype)
            : undefined,
          description: outcome.description,
          credit: outcome.credit
            ? enums.resolve(ApiWaveOutcomeCredit, outcome.credit)
            : undefined,
          rep_category: outcome.rep_category ?? undefined,
          amount: outcome.amount === null ? undefined : outcome.amount,
          index: outcome.wave_outcome_position
        })),
        next: count > params.page_size * params.page
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getOutcomes`);
    }
  }

  async getOutcomeDistribution(
    params: WaveOutcomeDistributionQuery,
    ctx: RequestContext
  ): Promise<ApiWaveOutcomeDistributionItemsPage> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getOutcomeDistribution`);
      const waveEntity = await this.wavesApiDb.findWaveById(
        params.wave_id,
        ctx.connection
      );
      if (!waveEntity) {
        throw new NotFoundException(`Wave not found`);
      }
      const eligibleGroups =
        await this.userGroupsService.getGroupsUserIsEligibleFor(
          ctx.authenticationContext?.getActingAsId() ?? null,
          ctx.timer
        );
      if (
        waveEntity.visibility_group_id !== null &&
        !eligibleGroups.includes(waveEntity.visibility_group_id)
      ) {
        throw new NotFoundException(`Wave not found`);
      }
      const [data, count] = await Promise.all([
        this.wavesApiDb.findOutcomeDistributionItems(
          {
            wave_id: params.wave_id,
            wave_outcome_position: params.outcome_index,
            limit: params.page_size,
            offset: params.page_size * (params.page - 1),
            order: params.sort_direction
          },
          ctx
        ),
        this.wavesApiDb.countOutcomeDistributionItems(
          {
            wave_id: params.wave_id,
            wave_outcome_position: params.outcome_index
          },
          ctx
        )
      ]);
      return {
        page: params.page,
        count,
        data: data.map<ApiWaveOutcomeDistributionItem>((item) => ({
          index: item.wave_outcome_distribution_item_position,
          amount: item.amount,
          description: item.description
        })),
        next: count > params.page_size * params.page
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getOutcomeDistribution`);
    }
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

export interface WaveOutcomesQuery {
  readonly wave_id: string;
  readonly page_size: number;
  readonly page: number;
  readonly sort_direction: PageSortDirection;
}

export interface WaveOutcomeDistributionQuery {
  readonly wave_id: string;
  readonly outcome_index: number;
  readonly page_size: number;
  readonly page: number;
  readonly sort_direction: PageSortDirection;
}

export const waveDecisionsApiService = new WaveDecisionsApiService(
  waveDecisionsDb,
  userGroupsService,
  wavesApiDb,
  dropsService
);
