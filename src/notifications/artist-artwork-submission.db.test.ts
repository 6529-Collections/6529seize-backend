import { ArtistArtworkAlertsDb } from './artist-artwork-alerts.db';
import { ArtistArtworkNotifications } from './artist-artwork-notifications';
import { competitionEventRepository } from '@/competitions/competition-event.repository';
import { pushNotificationOutboxDb } from './push-notification-outbox.db';
import { userNotifier } from './user.notifier';
import { DEFAULT_PROFILE_PREFERENCES } from '@/entities/IProfilePreferences';
import { randomUUID } from 'node:crypto';
import { DbPoolName } from '@/db-query.options';
import {
  artistArtworkNotificationVisibleSql,
  ArtistArtworkSubmissionDb
} from './artist-artwork-submission.db';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { sqlExecutor } from '@/sql-executor';
import * as tables from '@/constants';
import { WaveType } from '@/entities/IWave';

const wave = aWave(
  { type: WaveType.RANK },
  { id: 'artwork-wave', name: 'Main Stage' }
);
const parent = aWave(
  { visibility_group_id: 'private-group' },
  { id: 'private-parent', name: 'Private parent' }
);
const competition = nativeOriginalPrimaryFixture(wave);
const entryId = randomUUID();
const event = {
  competition_id: competition.id,
  competition_entry_id: entryId,
  wave_id: wave.id,
  drop_id: 'artwork'
};

describeWithSeed(
  'Artist artwork access and attribution',
  [
    withWaves([wave, parent]),
    { table: tables.COMPETITIONS_TABLE, rows: [competition] },
    {
      table: tables.DROPS_TABLE,
      rows: [
        {
          id: 'artwork',
          wave_id: wave.id,
          author_id: 'artist',
          created_at: 200,
          title: 'A work',
          parts_count: 1,
          drop_type: 'COMPETITION'
        }
      ]
    },
    {
      table: tables.COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: entryId,
          competition_id: competition.id,
          wave_id: wave.id,
          drop_id: 'artwork',
          submitter_id: 'artist',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 200
        }
      ]
    }
  ],
  () => {
    const db = new ArtistArtworkSubmissionDb(() => sqlExecutor);
    let notifierActivation: string | undefined;
    let pushActivation: string | undefined;
    beforeEach(() => {
      notifierActivation = process.env.USER_NOTIFIER_ACTIVATED;
      pushActivation = process.env.PUSH_NOTIFICATIONS_ACTIVATED;
      process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
      process.env.USER_NOTIFIER_ACTIVATED = 'true';
    });
    afterEach(() => {
      if (pushActivation === undefined)
        delete process.env.PUSH_NOTIFICATIONS_ACTIVATED;
      else process.env.PUSH_NOTIFICATIONS_ACTIVATED = pushActivation;
      jest.restoreAllMocks();
      if (notifierActivation === undefined)
        delete process.env.USER_NOTIFIER_ACTIVATED;
      else process.env.USER_NOTIFIER_ACTIVATED = notifierActivation;
    });

    it('uses the primary database before making terminal delivery decisions', async () => {
      const read = jest.spyOn(sqlExecutor, 'oneOrNull');
      const submission = (await db.find(event, {}))!;
      await db.canReceive(submission, 'viewer', [], {});
      await competitionEventRepository.getContext(
        {
          ...event,
          event_id: randomUUID(),
          event_version: 1,
          event_type: 'COMPETITION_ENTRY_CREATED',
          occurred_at: 200,
          data: { artwork_alert_eligible: true }
        },
        {}
      );
      expect(read).toHaveBeenCalledTimes(3);
      for (const call of read.mock.calls) {
        expect(call[2]).toMatchObject({ forcePool: DbPoolName.WRITE });
      }
    });

    it('rolls back the notification and receipt if the durable push handoff fails, then retries once', async () => {
      const preferences = new ArtistArtworkAlertsDb(() => sqlExecutor);
      await preferences.setEnabled(
        { subscriberId: 'viewer', artistId: 'artist' },
        true
      );
      await sqlExecutor.execute(
        `update ${tables.ARTIST_ARTWORK_ALERTS_TABLE} set enabled_at=100`
      );
      jest
        .spyOn(pushNotificationOutboxDb, 'enqueueMany')
        .mockRejectedValueOnce(new Error('outbox unavailable'));
      const service = new ArtistArtworkNotifications(
        preferences,
        db,
        competitionEventRepository,
        { getGroupsUserIsEligibleForByIds: async () => [] },
        {
          get: async () => DEFAULT_PROFILE_PREFERENCES,
          getMany: async () => new Map()
        },
        userNotifier,
        pushNotificationOutboxDb
      );
      const created = {
        ...event,
        event_id: randomUUID(),
        event_version: 1 as const,
        event_type: 'COMPETITION_ENTRY_CREATED',
        occurred_at: 200,
        data: { artwork_alert_eligible: true }
      };
      await expect(service.deliver(created, {})).rejects.toThrow(
        'outbox unavailable'
      );
      for (const table of [
        tables.IDENTITY_NOTIFICATIONS_TABLE,
        tables.COMPETITION_EVENT_EFFECTS_TABLE,
        tables.PUSH_NOTIFICATION_OUTBOX_TABLE
      ]) {
        expect(await sqlExecutor.execute(`select * from ${table}`)).toEqual([]);
      }
      expect(await service.deliver(created, {})).toBe(true);
      expect(await service.deliver(created, {})).toBe(true);
      for (const table of [
        tables.IDENTITY_NOTIFICATIONS_TABLE,
        tables.COMPETITION_EVENT_EFFECTS_TABLE,
        tables.PUSH_NOTIFICATION_OUTBOX_TABLE
      ]) {
        expect(
          await sqlExecutor.execute(`select * from ${table}`)
        ).toHaveLength(1);
      }
    });

    it.each(['VISIBLE', 'AI_QUARANTINED', 'MODERATOR_REMOVED'])(
      'deduplicates delivery and respects %s moderation through the shared notifier',
      async (status) => {
        await sqlExecutor.execute(
          `insert into ${tables.CONTENT_MODERATION_DROP_STATES_TABLE} (drop_id,status,updated_at) values ('artwork',:status,1)`,
          { status }
        );
        const preferences = new ArtistArtworkAlertsDb(() => sqlExecutor);
        await preferences.setEnabled(
          { subscriberId: 'viewer', artistId: 'artist' },
          true
        );
        await sqlExecutor.execute(
          `update ${tables.ARTIST_ARTWORK_ALERTS_TABLE} set enabled_at=100`
        );
        const push = jest.spyOn(pushNotificationOutboxDb, 'enqueueMany');
        const service = new ArtistArtworkNotifications(
          preferences,
          db,
          competitionEventRepository,
          { getGroupsUserIsEligibleForByIds: async () => [] },
          {
            get: async () => DEFAULT_PROFILE_PREFERENCES,
            getMany: async () => new Map()
          },
          userNotifier,
          pushNotificationOutboxDb
        );
        const created = {
          ...event,
          event_id: randomUUID(),
          event_version: 1 as const,
          event_type: 'COMPETITION_ENTRY_CREATED',
          occurred_at: 200,
          data: { artwork_alert_eligible: true }
        };
        await service.deliver(created, {});
        await service.deliver(created, {});
        const rows = await sqlExecutor.execute<{ id: number }>(
          `select id from ${tables.IDENTITY_NOTIFICATIONS_TABLE} where cause='ARTIST_ARTWORK_SUBMITTED' and identity_id='viewer'`
        );
        expect(rows).toHaveLength(status === 'VISIBLE' ? 1 : 0);
        const ids = rows.map((row) => Number(row.id));
        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith(
          ids,
          expect.objectContaining({ connection: expect.any(Object) })
        );
        const pending = await sqlExecutor.execute<{ notification_id: number }>(
          `select notification_id from ${tables.PUSH_NOTIFICATION_OUTBOX_TABLE}`
        );
        expect(pending.map((row) => Number(row.notification_id))).toEqual(ids);
      }
    );

    it('loads the exact current submission and rejects mismatched event references', async () => {
      expect(await db.find(event, {})).toMatchObject({
        artist_id: 'artist',
        artwork_title: 'A work',
        submitted_at: 200
      });
      expect(await db.find({ ...event, drop_id: 'other' }, {})).toBeNull();
      expect(await db.find({ ...event, wave_id: 'other' }, {})).toBeNull();
    });

    it.each(['WITHDRAWN', 'DISQUALIFIED'])(
      'excludes %s submissions',
      async (status) => {
        await sqlExecutor.execute(
          `update ${tables.COMPETITION_ENTRIES_TABLE} set status=:status`,
          { status }
        );
        expect(await db.find(event, {})).toBeNull();
      }
    );

    it('hides anonymous winners from artist targeting and existing notification queries', async () => {
      await sqlExecutor.execute(
        `update ${tables.COMPETITIONS_TABLE} set participation_config=json_set(participation_config, '$.anonymous_submissions', true)`
      );
      await sqlExecutor.execute(
        `update ${tables.COMPETITION_ENTRIES_TABLE} set status='WINNER'`
      );
      expect(await db.find(event, {})).toBeNull();
      const visible = () =>
        sqlExecutor.execute(
          `select n.related_drop_id from (select 'ARTIST_ARTWORK_SUBMITTED' as cause, 'artwork' as related_drop_id, 'artist' as additional_identity_id) n where ${artistArtworkNotificationVisibleSql('n')}`
        );
      expect(await visible()).toEqual([]);
      await sqlExecutor.execute(
        `update ${tables.COMPETITIONS_TABLE} set participation_config=json_set(participation_config, '$.anonymous_submissions', false)`
      );
      expect(await visible()).toHaveLength(1);
    });

    it('requires both child and parent wave access', async () => {
      await sqlExecutor.execute(
        `update ${tables.WAVES_TABLE} set parent_wave_id=:parent where id=:wave`,
        { parent: parent.id, wave: wave.id }
      );
      const submission = (await db.find(event, {}))!;
      expect(await db.canReceive(submission, 'viewer', [], {})).toBe(false);
      expect(
        await db.canReceive(submission, 'viewer', ['private-group'], {})
      ).toBe(true);
      await sqlExecutor.execute(
        `update ${tables.WAVES_TABLE} set visibility_group_id='child-group' where id=:wave`,
        { wave: wave.id }
      );
      expect(
        await db.canReceive(submission, 'viewer', ['private-group'], {})
      ).toBe(false);
      expect(
        await db.canReceive(
          submission,
          'viewer',
          ['private-group', 'child-group'],
          {}
        )
      ).toBe(true);
    });

    it.each([
      `insert into ${tables.IDENTITY_MUTES_TABLE} (muter_id,muted_identity_id,created_at) values ('viewer','artist',1)`,
      `insert into ${tables.CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} (blocker_profile_id,blocked_profile_id,created_at) values ('viewer','artist',1)`,
      `insert into ${tables.WAVE_READER_METRICS_TABLE} (wave_id,reader_id,muted) values ('artwork-wave','viewer',true)`
    ])('honours recipient suppression rules', async (sql) => {
      const submission = (await db.find(event, {}))!;
      expect(await db.canReceive(submission, 'viewer', [], {})).toBe(true);
      await sqlExecutor.execute(sql);
      expect(await db.canReceive(submission, 'viewer', [], {})).toBe(false);
      expect(await db.canReceive(submission, 'other-viewer', [], {})).toBe(
        true
      );
    });
  }
);
