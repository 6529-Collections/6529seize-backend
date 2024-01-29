import { Mock } from 'ts-jest-mocker';
import { ProfileRepSumEventListener } from './profile-rep-sum.event-listener';
import { RepScoreAggregationDb } from './rep-score-aggregation.db';
import { mockDbService } from '../../tests/test.helper';
import {
  EventStatus,
  EventType,
  ProcessableEvent
} from '../../entities/IEvent';
import { ProfileRepRatedEventData } from '../../events/datatypes/profile-rep-rated.event-data';

describe(`ProfileRepSumEventListener`, () => {
  let eventListener: ProfileRepSumEventListener;
  let repScoreAggregationDb: Mock<RepScoreAggregationDb>;

  beforeEach(() => {
    repScoreAggregationDb = mockDbService();
    eventListener = new ProfileRepSumEventListener(repScoreAggregationDb);
  });

  it('supports only PROFILE_REP_RATE event', async () => {
    expect(eventListener.supports(EventType.PROFILE_REP_RATE)).toBe(true);
    Object.values(EventType)
      .filter((it) => it !== EventType.PROFILE_REP_RATE)
      .forEach((it) => {
        expect(eventListener.supports(it)).toBe(false);
      });
  });

  it('groups, aggregates and saves REP sums and rater counts', async () => {
    const connection = { connection: {} };
    const eventDatas: ProfileRepRatedEventData[] = [
      {
        rater_profile_id: 'rater1',
        target_profile_id: 'target1',
        category: 'cat1',
        old_score: 5,
        new_score: 10
      },
      {
        rater_profile_id: 'rater1',
        target_profile_id: 'target1',
        category: 'cat1',
        old_score: 10,
        new_score: -5
      },
      {
        rater_profile_id: 'rater1',
        target_profile_id: 'target2',
        category: 'cat1',
        old_score: 0,
        new_score: -5
      },
      {
        rater_profile_id: 'rater1',
        target_profile_id: 'target3',
        category: 'cat1',
        old_score: -5,
        new_score: 0
      }
    ];
    const events: ProcessableEvent[] = eventDatas.map((data, idx) => ({
      id: idx,
      data: JSON.stringify(data),
      status: EventStatus.NEW,
      type: EventType.PROFILE_REP_RATE,
      created_at: 0,
      processed_at: null
    }));
    await eventListener.eventsFound(events, connection);
    expect(repScoreAggregationDb.upsertForProfile).toHaveBeenCalledWith(
      { profile_id: 'target1', rater_count: 0, score: -10 },
      connection
    );
    expect(repScoreAggregationDb.upsertForProfile).toHaveBeenCalledWith(
      { profile_id: 'target2', rater_count: 1, score: -5 },
      connection
    );
    expect(repScoreAggregationDb.upsertForProfile).toHaveBeenCalledWith(
      { profile_id: 'target3', rater_count: -1, score: 5 },
      connection
    );
  });
});
