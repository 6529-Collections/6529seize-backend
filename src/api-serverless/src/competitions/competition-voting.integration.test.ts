import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import { appFeatures } from '@/app-features';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { ApiSetCompetitionVoteRequest } from '@/api/generated/models/ApiSetCompetitionVoteRequest';
import * as tables from '@/constants';
import { IdentityNotificationEntity } from '@/entities/IIdentityNotification';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { competitionVotingService as service } from './competition-voting.service';

const author = 'competition-author';
const voter = 'competition-voter';
const competitionId = '20000000-0000-4000-8000-000000000001';
const entryId = '20000000-0000-4000-8000-000000000002';
const dropId = 'competition-submission';
const visibilityGroup = 'competition-members';
const wave = aWave({}, { id: 'competition-hub', name: 'Competition hub' });
const context = (profileId = voter) => ({
  authenticationContext: new AuthenticationContext({
    authenticatedWallet: '0x0000000000000000000000000000000000000001',
    authenticatedProfileId: profileId,
    roleProfileId: null,
    activeProxyActions: []
  })
});
const vote = (
  value: number,
  request: Partial<ApiSetCompetitionVoteRequest> = {},
  profileId = voter
) =>
  service.vote(
    wave.id,
    competitionId,
    entryId,
    { idempotency_key: randomUUID(), config_version: 1, value, ...request },
    context(profileId)
  );
const notifications = () =>
  sqlExecutor.execute<IdentityNotificationEntity>(
    `select * from ${tables.IDENTITY_NOTIFICATIONS_TABLE} order by id`
  );

describeWithSeed(
  'Native competition vote notifications',
  [
    withWaves([wave]),
    withIdentities(
      [author, voter].map((profileId, index) =>
        anIdentity(
          { tdh: 100 },
          {
            profile_id: profileId,
            consolidation_key: `0xfixture${index}`,
            primary_address: `0xfixture${index}`,
            handle: profileId
          }
        )
      )
    ),
    {
      table: tables.COMPETITIONS_TABLE,
      rows: [
        {
          id: competitionId,
          wave_id: wave.id,
          storage_mode: 'NATIVE',
          execution_mode: 'ACTIVE',
          type: 'RANK',
          lifecycle: 'PUBLISHED',
          title: 'Notification fixture',
          participation_config: {},
          voting_config: {
            group_id: null,
            credit_type: 'TDH',
            credit_scope: 'WAVE',
            signature_required: false,
            starts_at: null,
            ends_at: null,
            max_votes_per_identity_to_entry: null,
            forbid_negative_votes: false
          },
          decision_config: {
            strategy: null,
            next_decision_time: null,
            winning_min_threshold: null,
            winning_max_threshold: null,
            winning_threshold_min_duration_ms: 0,
            max_winners: null,
            time_lock_ms: null
          },
          winner_config: {
            max_winners: null,
            winning_min_threshold: null,
            winning_max_threshold: null,
            winning_threshold_min_duration_ms: 0
          },
          outcome_config: [],
          config_version: 1,
          published_at: 1,
          created_at: 1,
          updated_at: 1
        }
      ]
    },
    {
      table: tables.DROPS_TABLE,
      rows: [
        {
          id: dropId,
          wave_id: wave.id,
          author_id: author,
          created_at: 1,
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
          competition_id: competitionId,
          wave_id: wave.id,
          drop_id: dropId,
          submitter_id: author,
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 1
        }
      ]
    },
    {
      table: tables.COMPETITION_VOTES_TABLE,
      rows: [
        {
          id: 'author-vote',
          competition_id: competitionId,
          entry_id: entryId,
          voter_profile_id: author,
          value: 4,
          credit_spent: 4,
          created_at: 1,
          updated_at: 1
        }
      ]
    }
  ],
  () => {
    let originalNotifier: string | undefined;
    let originalPush: string | undefined;
    beforeEach(() => {
      originalNotifier = process.env.USER_NOTIFIER_ACTIVATED;
      originalPush = process.env.PUSH_NOTIFICATIONS_ACTIVATED;
      process.env.USER_NOTIFIER_ACTIVATED = 'true';
      process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
      jest
        .spyOn(appFeatures, 'isNativeCompetitionWritesEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionExecutionEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue([visibilityGroup]);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      if (originalNotifier === undefined)
        delete process.env.USER_NOTIFIER_ACTIVATED;
      else process.env.USER_NOTIFIER_ACTIVATED = originalNotifier;
      if (originalPush === undefined)
        delete process.env.PUSH_NOTIFICATIONS_ACTIVATED;
      else process.env.PUSH_NOTIFICATIONS_ACTIVATED = originalPush;
    });

    it.each([null, visibilityGroup])(
      'creates a vote notification and durable push with visibility %s',
      async (visibilityGroupId) => {
        await sqlExecutor.execute(
          `update ${tables.WAVES_TABLE} set visibility_group_id=:visibilityGroupId where id=:id`,
          { id: wave.id, visibilityGroupId }
        );
        await expect(vote(10)).resolves.toMatchObject({ current_vote: 10 });
        const rows = await notifications();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          identity_id: author,
          additional_identity_id: voter,
          related_drop_id: dropId,
          wave_id: wave.id,
          cause: 'DROP_VOTED',
          visibility_group_id: visibilityGroupId
        });
        expect(JSON.parse(rows[0].additional_data)).toEqual({
          vote: 10,
          vote_change: 10,
          total_vote: 14
        });
        expect(
          await sqlExecutor.execute(
            `select notification_id from ${tables.PUSH_NOTIFICATION_OUTBOX_TABLE}`
          )
        ).toEqual([{ notification_id: rows[0].id }]);
      }
    );

    it.each([
      [15, 5, 19],
      [3, -7, 7],
      [0, -10, 4],
      [-3, -13, 1]
    ])(
      'notifies when a vote changes from 10 to %s',
      async (value, change, total) => {
        await vote(10);
        await vote(value);
        const rows = await notifications();
        expect(rows).toHaveLength(2);
        expect(JSON.parse(rows[1].additional_data)).toEqual({
          vote: value,
          vote_change: change,
          total_vote: total
        });
      }
    );

    it('does not duplicate notifications on retries or unchanged replacement votes', async () => {
      const request = { idempotency_key: randomUUID() };
      await vote(10, request);
      await vote(10, request);
      await vote(10);
      expect(await notifications()).toHaveLength(1);
      expect(
        await sqlExecutor.execute(
          `select notification_id from ${tables.PUSH_NOTIFICATION_OUTBOX_TABLE}`
        )
      ).toHaveLength(1);
      expect(
        await sqlExecutor.execute(
          `select sequence from ${tables.COMPETITION_VOTE_HISTORY_TABLE}`
        )
      ).toHaveLength(1);
    });

    it('does not notify the submitter about their own votes', async () => {
      await expect(vote(10, {}, author)).resolves.toMatchObject({
        current_vote: 10
      });
      expect(await notifications()).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `select notification_id from ${tables.PUSH_NOTIFICATION_OUTBOX_TABLE}`
        )
      ).toEqual([]);
    });

    it('rolls back the notification and push alongside a failed vote command', async () => {
      jest
        .spyOn(nativeCompetitionRuntimeService, 'refreshCompetition')
        .mockRejectedValueOnce(new Error('Refresh failed'));
      const request = { idempotency_key: randomUUID() };
      await expect(vote(10, request)).rejects.toThrow('Refresh failed');
      expect(await notifications()).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `select notification_id from ${tables.PUSH_NOTIFICATION_OUTBOX_TABLE}`
        )
      ).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_COMMANDS_TABLE}`
        )
      ).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `select value from ${tables.COMPETITION_VOTES_TABLE} where voter_profile_id=:voter`,
          { voter }
        )
      ).toEqual([]);
      await expect(vote(10, request)).resolves.toMatchObject({
        current_vote: 10
      });
      expect(await notifications()).toHaveLength(1);
    });
  }
);
