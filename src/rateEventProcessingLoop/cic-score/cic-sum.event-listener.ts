import { EventListener } from '../../events/event.listener';
import { EventType, ProcessableEvent } from '../../entities/IEvent';
import { ConnectionWrapper } from '../../sql-executor';
import { Logger } from '../../logging';
import {
  cicScoreAggregationDb,
  CicScoreAggregationDb
} from './cic-score-aggregation.db';
import { ProfileCicRatedEventData } from '../../events/datatypes/profile-cic-rated.event-data';

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
    const scoreChangesByProfile = data.reduce((acc, event) => {
      const currentScore = acc[event.target_profile_id]?.score ?? 0;
      const currentRaterCount = acc[event.target_profile_id]?.rater_count ?? 0;
      let raterCountChange = 0;
      if (event.old_score === 0 && event.new_score !== 0) {
        raterCountChange = 1;
      } else if (event.old_score !== 0 && event.new_score === 0) {
        raterCountChange = -1;
      }
      const scoreChange = event.new_score - event.old_score;
      acc[event.target_profile_id] = {
        score: currentScore + scoreChange,
        rater_count: currentRaterCount + raterCountChange
      };
      return acc;
    }, {} as Record<string, { score: number; rater_count: number }>);
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
