import { AuthenticationContext } from '@/auth-context';
import { apiDropMapper } from '@/api/drops/api-drop.mapper';
import { dropsMappers } from '@/api/drops/drops.mappers';
import { identitiesActivityDb } from '@/api/identities/identities.activity.db';
import { dropsDb } from '@/drops/drops.db';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import * as tables from '@/constants';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';

const owner = 'anonymous-read-owner';
const ownerHandle = 'PrivateReadArtist';
const wallet = '0x0000000000000000000000000000000000000001';
const wave = aWave({}, { id: 'anonymous-read-wave', name: 'Anonymous reads' });
const competitionId = 'anonymous-read-competition';
const dropIds = ['anonymous-read-one', 'anonymous-read-two', 'read-winner'];
const publicCtx = {
  authenticationContext: AuthenticationContext.notAuthenticated()
};
const ownerCtx = {
  authenticationContext: AuthenticationContext.fromProfileId(owner)
};

describeWithSeed(
  'Anonymous competition public reads',
  [
    withWaves([wave]),
    withProfiles([
      aProfile({
        external_id: owner,
        handle: ownerHandle,
        primary_wallet: wallet
      })
    ]),
    withIdentities([
      anIdentity(
        {},
        {
          profile_id: owner,
          handle: ownerHandle,
          primary_address: wallet,
          consolidation_key: wallet
        }
      )
    ]),
    {
      table: tables.COMPETITIONS_TABLE,
      rows: [
        {
          id: competitionId,
          wave_id: wave.id,
          legacy_wave_id: null,
          execution_mode: 'ACTIVE',
          type: 'RANK',
          lifecycle: 'PUBLISHED',
          title: 'Anonymous reads',
          participation_config: { anonymous_submissions: true },
          voting_config: {},
          decision_config: {},
          winner_config: {},
          outcome_config: [],
          created_at: 1,
          updated_at: 1,
          published_at: 1
        }
      ]
    },
    {
      table: tables.DROPS_TABLE,
      rows: [
        ...dropIds.map((id) => ({
          id,
          wave_id: wave.id,
          author_id: owner,
          drop_type: 'COMPETITION',
          created_at: 10,
          parts_count: 1,
          hide_link_preview: false
        })),
        {
          id: 'anonymous-discussion',
          wave_id: wave.id,
          author_id: owner,
          drop_type: 'CHAT',
          created_at: 11,
          parts_count: 1,
          hide_link_preview: false,
          reply_to_drop_id: dropIds[1],
          reply_to_part_id: 1
        }
      ]
    },
    {
      table: tables.DROPS_PARTS_TABLE,
      rows: [
        ...dropIds.map((id) => ({
          drop_id: id,
          drop_part_id: 1,
          content: `Submitted ${id}`,
          quoted_drop_id: null
        })),
        {
          drop_id: 'anonymous-discussion',
          drop_part_id: 1,
          content: 'Discussion',
          quoted_drop_id: dropIds[0],
          quoted_drop_part_id: 1
        }
      ]
    },
    {
      table: tables.COMPETITION_ENTRIES_TABLE,
      rows: dropIds.map((id, index) => ({
        id: `entry-${id}`,
        competition_id: competitionId,
        wave_id: wave.id,
        drop_id: id,
        submitter_id: owner,
        status: index === 2 ? 'WINNER' : 'ACTIVE',
        won_at: index === 2 ? 20 : null,
        config_version: 1,
        submitted_at: 10
      }))
    },
    {
      table: tables.PROFILES_ACTIVITY_LOGS_TABLE,
      rows: dropIds.map((id, index) => ({
        id: `log-${id}`,
        profile_id: owner,
        target_id: id,
        proxy_id: null,
        type: 'DROP_CREATED',
        contents: {},
        additional_data_1: 'COMPETITION',
        additional_data_2: wave.id,
        created_at: new Date(1000 + index)
      }))
    }
  ],
  () => {
    it('does not reveal an anonymous author through account blocks while preserving explicit hiding and moderation', async () => {
      const reader = 'candidate-prober';
      const ctx = {
        authenticationContext: AuthenticationContext.fromProfileId(reader)
      };
      await sqlExecutor.execute(
        `insert into ${tables.CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} (blocker_profile_id,blocked_profile_id,created_at) values (:reader,:owner,1)`,
        { reader, owner }
      );
      await sqlExecutor.execute(
        `insert into ${tables.CONTENT_MODERATION_HIDDEN_DROPS_TABLE} (profile_id,drop_id,created_at) values (:reader,:dropId,1)`,
        { reader, dropId: dropIds[1] }
      );
      const entities = await dropsDb.getDropsByIds([
        ...dropIds,
        'anonymous-discussion'
      ]);
      const presentations = await contentModerationDb.getPresentations(
        entities,
        reader
      );
      expect(presentations[dropIds[0]].viewer).toMatchObject({
        author_blocked: false,
        drop_hidden: false
      });
      expect(presentations[dropIds[1]].viewer).toMatchObject({
        author_blocked: false,
        drop_hidden: true
      });
      expect(presentations['read-winner'].viewer.author_blocked).toBe(true);
      expect(presentations['anonymous-discussion'].viewer.author_blocked).toBe(
        true
      );
      const drops = await apiDropMapper.mapDrops(entities, ctx, {
        includeSubmissionVoting: false
      });
      expect(drops[dropIds[0]].viewer_context?.author_blocked).toBe(false);
      expect(drops[dropIds[0]].content).toBe(`Submitted ${dropIds[0]}`);
      const socketContexts = await contentModerationDb.getViewerContextsForDrop(
        {
          dropId: dropIds[0],
          authorProfileId: owner,
          viewerProfileIds: [reader]
        }
      );
      expect(socketContexts[reader]).toMatchObject({
        author_blocked: false,
        drop_hidden: false
      });
      const hiddenSocketContext =
        await contentModerationDb.getViewerContextsForDrop({
          dropId: dropIds[1],
          authorProfileId: owner,
          viewerProfileIds: [reader]
        });
      expect(hiddenSocketContext[reader]).toMatchObject({
        author_blocked: false,
        drop_hidden: true
      });
      await sqlExecutor.execute(
        `insert into ${tables.CONTENT_MODERATION_DROP_STATES_TABLE} (drop_id,status,updated_at) values (:dropId,'MODERATOR_REMOVED',1)`,
        { dropId: dropIds[0] }
      );
      const removed = await apiDropMapper.mapDrops(entities, ctx, {
        includeSubmissionVoting: false
      });
      expect(removed[dropIds[0]].moderation?.can_view).toBe(false);
      expect(removed[dropIds[0]].content).toBeUndefined();
    });

    it('conceals v1/v2 authors and embedded references while revealing only the winning entry', async () => {
      const entities = await dropsDb.getDropsByIds([
        ...dropIds,
        'anonymous-discussion'
      ]);
      const v2 = await apiDropMapper.mapDrops(entities, publicCtx, {
        includeSubmissionVoting: false
      });
      const v1 = await dropsMappers.convertToDropsWithoutWaves(
        entities,
        publicCtx
      );
      for (const id of dropIds.slice(0, 2)) {
        expect(v2[id].author).toMatchObject({
          is_anonymous: true,
          handle: 'Anonymous',
          primary_address: ''
        });
        expect(v1.find((drop) => drop.id === id)?.author).toMatchObject({
          is_anonymous: true
        });
        expect(v2[id].author.id).not.toBe(owner);
      }
      expect(v2[dropIds[0]].author.id).not.toBe(v2[dropIds[1]].author.id);
      expect(v2['read-winner'].author.id).toBe(owner);
      const discussion = v1.find((drop) => drop.id === 'anonymous-discussion');
      expect(discussion?.parts[0].quoted_drop?.drop?.author).toMatchObject({
        is_anonymous: true
      });
      expect(discussion?.reply_to?.drop?.author).toMatchObject({
        is_anonymous: true
      });
      expect(v2['anonymous-discussion'].reply_to_drop?.author).toEqual({
        handle: 'Anonymous',
        is_anonymous: true
      });
      const own = await apiDropMapper.mapDrops(entities, ownerCtx, {
        includeSubmissionVoting: false
      });
      expect(own[dropIds[0]].author.id).toBe(owner);
    });

    it('protects author-filtered search and author autocomplete before limits', async () => {
      const search = await dropsDb.searchDropsInWave(
        { wave_id: wave.id, author_id: owner, limit: 10, offset: 0 },
        publicCtx
      );
      expect(
        search.map((drop) => drop.id).sort((a, b) => a.localeCompare(b))
      ).toEqual(['anonymous-discussion', 'read-winner']);
      const mine = await dropsDb.searchDropsInWave(
        { wave_id: wave.id, author_id: owner, limit: 10, offset: 0 },
        ownerCtx
      );
      expect(mine).toHaveLength(4);
      await sqlExecutor.execute(
        `delete from ${tables.DROPS_TABLE} where id='anonymous-discussion'`
      );
      await sqlExecutor.execute(
        `update ${tables.COMPETITION_ENTRIES_TABLE} set won_at=null,status='ACTIVE' where drop_id='read-winner'`
      );
      expect(
        await dropsDb.searchWaveAuthors(
          { wave_id: wave.id, handle: ownerHandle, limit: 10 },
          publicCtx
        )
      ).toEqual([]);
      expect(
        await dropsDb.searchWaveAuthors(
          { wave_id: wave.id, handle: ownerHandle, limit: 10 },
          ownerCtx
        )
      ).toHaveLength(1);
    });

    it('omits unrevealed submissions from public profile counts and identifying activity pages', async () => {
      const counts = await identitiesActivityDb.getPublicWaveDailyDropCounts(
        { profileId: owner, startInclusive: 0, endExclusive: 100 },
        publicCtx
      );
      expect(Number(counts[0]?.drop_count)).toBe(2);
      const request = {
        profile_id: owner,
        type: [ProfileActivityLogType.DROP_CREATED],
        includeProfileIdToIncoming: false,
        viewer_eligible_group_ids: [],
        group_id: null,
        order: 'desc' as const,
        pageRequest: { page: 1, page_size: 1 }
      };
      expect(
        (await profileActivityLogsDb.searchLogs(request, publicCtx)).map(
          (log) => log.target_id
        )
      ).toEqual(['read-winner']);
      expect(
        await profileActivityLogsDb.searchLogs(request, ownerCtx)
      ).toHaveLength(2);
    });
  }
);
