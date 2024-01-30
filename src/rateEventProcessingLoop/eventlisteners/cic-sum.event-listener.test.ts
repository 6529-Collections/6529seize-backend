import { Mock } from 'ts-jest-mocker';
import { CicSumEventListener } from './cic-sum.event-listener';
import { CicScoreAggregationDb } from '../../aggregations/cic-score-aggregation.db';
import { mockDbService } from '../../tests/test.helper';
import {
  EventStatus,
  EventType,
  ProcessableEvent
} from '../../entities/IEvent';
import { ProfileCicRatedEventData } from '../../events/datatypes/profile-cic-rated.event-data';

describe(`CicSumEventListener`, () => {
  let eventListener: CicSumEventListener;
  let cicScoreAggregationDb: Mock<CicScoreAggregationDb>;

  beforeEach(() => {
    cicScoreAggregationDb = mockDbService();
    eventListener = new CicSumEventListener(cicScoreAggregationDb);
  });

  it('supports only PROFILE_CIC_RATE event', async () => {
    expect(eventListener.supports(EventType.PROFILE_CIC_RATE)).toBe(true);
    Object.values(EventType)
      .filter((it) => it !== EventType.PROFILE_CIC_RATE)
      .forEach((it) => {
        expect(eventListener.supports(it)).toBe(false);
      });
  });

  it('groups, aggregates and saves CIC sums and rater counts', async () => {
    const connection = { connection: {} };
    const eventDatas: ProfileCicRatedEventData[] = [
      {
        rater_profile_id: 'rater1',
        target_profile_id: 'target1',
        old_score: 5,
        new_score: 10
      },
      {
        rater_profile_id: 'rater1',
        target_profile_id: 'target1',
        old_score: 10,
        new_score: -5
      },
      {
        rater_profile_id: 'rater1',
        target_profile_id: 'target2',
        old_score: 0,
        new_score: -5
      },
      {
        rater_profile_id: 'rater1',
        target_profile_id: 'target3',
        old_score: -5,
        new_score: 0
      }
    ];
    const events: ProcessableEvent[] = eventDatas.map((data, idx) => ({
      id: idx,
      data: JSON.stringify(data),
      status: EventStatus.NEW,
      type: EventType.PROFILE_CIC_RATE,
      created_at: 0,
      processed_at: null
    }));
    await eventListener.eventsFound(events, connection);
    expect(cicScoreAggregationDb.upsertForProfile).toHaveBeenCalledWith(
      { profile_id: 'target1', rater_count: 0, score: -10 },
      connection
    );
    expect(cicScoreAggregationDb.upsertForProfile).toHaveBeenCalledWith(
      { profile_id: 'target2', rater_count: 1, score: -5 },
      connection
    );
    expect(cicScoreAggregationDb.upsertForProfile).toHaveBeenCalledWith(
      { profile_id: 'target3', rater_count: -1, score: 5 },
      connection
    );
  });
});
