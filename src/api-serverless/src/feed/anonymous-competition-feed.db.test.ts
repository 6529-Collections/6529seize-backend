import { FeedDb } from '@/api/feed/feed.db';
import {
  ACTIVITY_EVENTS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE
} from '@/constants';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

const wave = aWave(
  { type: WaveType.RANK },
  { id: 'anonymous-feed-wave', name: 'Competition' }
);

describeWithSeed(
  'anonymous entry identity-follow feed privacy',
  withWaves([wave]),
  () => {
    it('filters identity-follow events before pagination while keeping wave delivery and own entries', async () => {
      const competition = await seedNativeOriginalPrimaryFixture(wave);
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set participation_config = json_set(participation_config, '$.anonymous_submissions', true) where id=:id`,
        { id: competition.id }
      );
      const entries = [
        {
          id: 'active-entry',
          drop_id: 'active-drop',
          status: 'ACTIVE',
          won_at: null
        },
        {
          id: 'winner-entry',
          drop_id: 'winner-drop',
          status: 'WINNER',
          won_at: 5
        }
      ].map((entry) => ({
        ...entry,
        wave_id: wave.id,
        competition_id: competition.id,
        submitter_id: 'author',
        config_version: 1,
        submitted_at: 1
      }));
      await sqlExecutor.bulkInsert(
        COMPETITION_ENTRIES_TABLE,
        entries,
        Object.keys(entries[0])
      );
      const subscriptions = ['IDENTITY', 'WAVE'].map((target_type) => ({
        subscriber_id: 'reader',
        target_id: target_type === 'IDENTITY' ? 'author' : wave.id,
        target_type,
        target_action: 'DROP_CREATED'
      }));
      await sqlExecutor.bulkInsert(
        IDENTITY_SUBSCRIPTIONS_TABLE,
        subscriptions,
        Object.keys(subscriptions[0])
      );
      const events = [
        {
          id: 20,
          drop_id: 'active-drop',
          target_type: 'IDENTITY',
          target_id: 'author'
        },
        {
          id: 15,
          drop_id: 'active-drop',
          target_type: 'WAVE',
          target_id: wave.id
        },
        {
          id: 10,
          drop_id: 'winner-drop',
          target_type: 'IDENTITY',
          target_id: 'author'
        }
      ].map((event) => ({
        ...event,
        wave_id: wave.id,
        action: 'DROP_CREATED',
        action_author_id: 'author',
        created_at: 1,
        data: JSON.stringify({ drop_id: event.drop_id, creator_id: 'author' })
      }));
      await sqlExecutor.bulkInsert(
        ACTIVITY_EVENTS_TABLE,
        events,
        Object.keys(events[0])
      );
      const db = new FeedDb(() => sqlExecutor);
      const request = {
        subscriber_id: 'reader',
        visibility_group_ids: [],
        limit: 1,
        serial_no_less_than: null
      };
      const ids = async (subscriber_id = 'reader') =>
        (await db.getNextActivityEvents({ ...request, subscriber_id })).map(
          (event) => Number(event.id)
        );

      expect(await ids()).toEqual([15]);
      await sqlExecutor.execute(
        `delete from ${IDENTITY_SUBSCRIPTIONS_TABLE} where target_type='WAVE'`
      );
      expect(await ids()).toEqual([10]);
      expect(await ids('author')).toEqual([20]);
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set won_at=10, status='WINNER' where id='active-entry'`
      );
      expect(await ids()).toEqual([20]);
    });
  }
);
