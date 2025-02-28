import { PageSortDirection } from '../page-request';
import { ApiWaveDecisionsPage } from '../generated/models/ApiWaveDecisionsPage';
import { RequestContext } from '../../../request.context';

export class WaveDecisionsService {
  public async searchConcludedWaveDecisions(
    query: WaveDecisionsQuery,
    ctx: RequestContext
  ): Promise<ApiWaveDecisionsPage> {
    ctx.timer?.start(`${this.constructor.name}->searchConcludedWaveDecisions`);
    ctx.timer?.stop(`${this.constructor.name}->searchConcludedWaveDecisions`);
    return {
      page: query.page,
      next: false,
      count: 0,
      data: []
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

export const waveDecisionsService = new WaveDecisionsService();
