import { ArtistArtworkAlertsDb } from './artist-artwork-alerts.db';
import { ArtistArtworkNotifications } from './artist-artwork-notifications';
import { competitionEventRepository } from '@/competitions/competition-event.repository';
import { userNotifier } from './user.notifier';
import { DEFAULT_PROFILE_PREFERENCES } from '@/entities/IProfilePreferences';
import { randomUUID } from 'node:crypto';
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
    beforeEach(() => {
      notifierActivation = process.env.USER_NOTIFIER_ACTIVATED;
      process.env.USER_NOTIFIER_ACTIVATED = 'true';
    });
    afterEach(() => {
      if (notifierActivation === undefined)
        delete process.env.USER_NOTIFIER_ACTIVATED;
      else process.env.USER_NOTIFIER_ACTIVATED = notifierActivation;
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
        const push = jest.fn().mockResolvedValue(undefined);
        const service = new ArtistArtworkNotifications(
          preferences,
          db,
          competitionEventRepository,
          { getGroupsUserIsEligibleFor: async () => [] },
          { get: async () => DEFAULT_PROFILE_PREFERENCES },
          userNotifier,
          push
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
        expect(push.mock.calls).toEqual([[ids], [ids]]);
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
