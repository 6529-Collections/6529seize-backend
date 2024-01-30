import { EventListener } from '../../events/event.listener';
import { EventType, ProcessableEvent } from '../../entities/IEvent';
import { ConnectionWrapper } from '../../sql-executor';
import { Logger } from '../../logging';
import {
  repScoreAggregationDb,
  RepScoreAggregationDb
} from '../../aggregations/rep-score-aggregation.db';
import { ProfileRepRatedEventData } from '../../events/datatypes/profile-rep-rated.event-data';
import { aggregateScoresAndCountsByTarget } from '../aggregations.helper';

export class ProfileRepSumEventListener implements EventListener {
  private readonly logger = Logger.get('PROFILE_REP_SUM_EVENT_LISTENER');

  constructor(private readonly repScoreAggregationDb: RepScoreAggregationDb) {}

  async eventsFound(
    events: ProcessableEvent[],
    connection: ConnectionWrapper<any>
  ) {
    const data: ProfileRepRatedEventData[] = events.map((event) =>
      JSON.parse(event.data)
    );
    const scoreChangesByProfile = aggregateScoresAndCountsByTarget(data);
    for (const entry of Object.entries(scoreChangesByProfile)) {
      const [profile_id, score] = entry;
      await this.repScoreAggregationDb.upsertForProfile(
        { profile_id, score: score.score, rater_count: score.rater_count },
        connection
      );
    }
  }

  supports(event: EventType): boolean {
    return event === EventType.PROFILE_REP_RATE;
  }

  uniqueKey(): string {
    return 'RECEIVED_PROFILE_REP_SUM';
  }
}

export const profileRepSumEventListener = new ProfileRepSumEventListener(
  repScoreAggregationDb
);
