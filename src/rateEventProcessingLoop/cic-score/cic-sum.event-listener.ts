import { EventListener } from '../../events/event.listener';
import { EventType, ProcessableEvent } from '../../entities/IEvent';
import { ConnectionWrapper } from '../../sql-executor';
import { Logger } from '../../logging';
import {
  cicScoreAggregationDb,
  CicScoreAggregationDb
} from './cic-score-aggregation.db';
import { ProfileCicRatedEventData } from '../../events/datatypes/profile-cic-rated.event-data';
import { aggregateScoresAndCountsByTarget } from '../aggregations.helper';

export class CicSumEventListener implements EventListener {
  private readonly logger = Logger.get('CIC_SUM_EVENT_LISTENER');

  constructor(private readonly cicScoreAggregationDb: CicScoreAggregationDb) {}

  async eventsFound(
    events: ProcessableEvent[],
    connection: ConnectionWrapper<any>
  ) {
    const data: ProfileCicRatedEventData[] = events.map((event) =>
      JSON.parse(event.data)
    );
    const scoreChangesByProfile = aggregateScoresAndCountsByTarget(data);
    for (const entry of Object.entries(scoreChangesByProfile)) {
      const [profile_id, score] = entry;
      await this.cicScoreAggregationDb.upsertForProfile(
        { profile_id, score: score.score, rater_count: score.rater_count },
        connection
      );
    }
  }

  supports(event: EventType): boolean {
    return event === EventType.PROFILE_CIC_RATE;
  }

  uniqueKey(): string {
    return 'RECEIVED_CIC_SUM';
  }
}

export const cicSumEventListener = new CicSumEventListener(
  cicScoreAggregationDb
);
