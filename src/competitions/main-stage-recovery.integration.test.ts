import { randomUUID } from 'node:crypto';
import { Wallet } from 'ethers';
import * as tables from '@/constants';
import { appFeatures } from '@/app-features';
import { AuthenticationContext } from '@/auth-context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { migrationFixtureOperator as operator } from '@/tests/fixtures/competition-migration.fixture';
import { WaveType } from '@/entities/IWave';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiCreateCompetitionEntryRequest } from '@/api/generated/models/ApiCreateCompetitionEntryRequest';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { competitionVotingService } from '@/api/competitions/competition-voting.service';
import { competitionEntryService } from '@/api/competitions/competition-entry.service';
import { listCompetitionVoteActivity } from '@/api/competitions/competition-vote-activity.service';
import { voteForDropUseCase } from '@/drops/vote-for-drop.use-case';
import { revokeTdhBasedDropWavesOverVotes } from '@/drops/participation-drops-over-vote-revocation';
import { userNotifier } from '@/notifications/user.notifier';
import * as pushes from '@/api/push-notifications/push-notifications.service';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import * as safeFetch from '@/http/safe-fetch';
import { MintingClaimsService } from '@/minting-claims/minting-claims.service';
import { mintingClaimsDb } from '@/minting-claims/minting-claims.db';
import { memeCardDropMappingsDb } from '@/minting-claims/meme-card-drop-mappings.db';
import { dropsDb } from '@/drops/drops.db';
import {
  canonicalCompetitionJson,
  competitionPayloadHash
} from './competition-command-identity';
import { CompetitionRepository } from './competition.repository';
import { CompetitionMigrationService } from './competition-migration.service';
import { installMigrationCapture } from './competition-migration-capture';
import {
  legacyCompetitionId,
  legacyCompetitionEntryId
} from './competition-id';
import { migrateWave } from './wave-migration';
import { CompetitionEventDispatcher } from './competition-event-dispatcher';
import { competitionEventRepository } from './competition-event.repository';
import { nativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { nativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { mirrorNativeLegacyVoteActivity } from './legacy-competition-mirror';
import { competitionCreditService } from './competition-credit.service';
import { Timer } from '@/time';

const day = 86_400_000;
const start = Date.UTC(2026, 9, 1, 12);
const wave = aWave(
  {
    type: WaveType.RANK,
    participation_period_start: start - day,
    voting_period_start: start - day,
    voting_signature_required: false,
    participation_signature_required: true,
    participation_max_applications_per_participant: 3,
    forbid_negative_votes: false,
    time_lock_ms: day,
    next_decision_time: start + 2 * day,
    decisions_strategy: {
      first_decision_time: start + 2 * day,
      subsequent_decisions: [2 * day, 2 * day, 3 * day],
      is_rolling: true
    }
  },
  {
    id: 'recovery-disposable-main-stage',
    name: 'Synthetic Main Stage recovery',
    serial_no: 1
  }
);
const id = legacyCompetitionId(wave.id);
const dropId = 'recovery-legacy-drop';
const entryId = legacyCompetitionEntryId(id, dropId);
const wallet = Wallet.createRandom();
const actor = 'recovery-voter';
const proxy = 'recovery-proxy';
const actorContext = {
  authenticationContext: new AuthenticationContext({
    authenticatedWallet: wallet.address,
    authenticatedProfileId: actor,
    roleProfileId: null,
    activeProxyActions: []
  })
};
const proxyContext = {
  authenticationContext: new AuthenticationContext({
    authenticatedWallet: wallet.address,
    authenticatedProfileId: proxy,
    roleProfileId: actor,
    activeProxyActions: [
      {
        id: 'recovery-proxy-rate',
        type: ProfileProxyActionType.RATE_WAVE_DROP,
        credit_amount: null,
        credit_spent: null
      }
    ]
  })
};
const identities = [actor, proxy].map((profile_id) =>
  anIdentity(
    { tdh: 100 },
    {
      profile_id,
      consolidation_key:
        profile_id === actor ? wallet.address.toLowerCase() : '0xproxy',
      primary_address:
        profile_id === actor ? wallet.address.toLowerCase() : '0xproxy',
      handle: profile_id
    }
  )
);

// Only synthetic rows are seeded; no .env, remote database or live external client is used.
describeWithSeed(
  'Main Stage recovery qualification',
  [
    withWaves([wave]),
    {
      table: tables.WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
      rows: [
        {
          wave_id: wave.id,
          wave_outcome_position: 1,
          wave_outcome_distribution_item_position: 1,
          description: 'First',
          amount: null
        }
      ]
    },
    {
      table: tables.WAVE_OUTCOMES_TABLE,
      rows: [
        {
          wave_id: wave.id,
          wave_outcome_position: 1,
          type: 'MANUAL',
          subtype: null,
          description: 'Synthetic winner',
          credit: null,
          rep_category: null,
          amount: null
        }
      ]
    },
    {
      table: tables.IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: [
        {
          subscriber_id: proxy,
          target_id: wave.id,
          target_type: 'WAVE',
          target_action: 'DROP_CREATED'
        }
      ]
    },
    withIdentities(identities),
    withProfiles(
      identities.map((identity) =>
        aProfile({
          external_id: identity.profile_id!,
          handle: identity.handle!,
          primary_wallet: identity.primary_address
        })
      )
    ),
    {
      table: tables.DROPS_TABLE,
      rows: [
        {
          id: dropId,
          wave_id: wave.id,
          author_id: actor,
          created_at: start - day,
          updated_at: null,
          title: null,
          parts_count: 1,
          drop_type: 'PARTICIPATORY',
          signature: 'retained-legacy-signature',
          hide_link_preview: false
        }
      ]
    },
    {
      table: tables.DROP_RANK_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: wave.id,
          vote: 7,
          last_increased: start - day
        }
      ]
    },
    {
      table: tables.DROP_VOTER_STATE_TABLE,
      rows: [{ drop_id: dropId, wave_id: wave.id, voter_id: actor, votes: 7 }]
    },
    {
      table: tables.DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: wave.id,
          voter_id: actor,
          credit_spent: 7,
          created_at: start - day
        }
      ]
    },
    {
      table: tables.DROP_REAL_VOTE_IN_TIME_TABLE,
      rows: [
        { drop_id: dropId, wave_id: wave.id, timestamp: start - day, vote: 7 }
      ]
    },
    {
      table: tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: wave.id,
          voter_id: actor,
          timestamp: start - day,
          vote: 7
        }
      ]
    },
    {
      table: tables.WAVE_LEADERBOARD_ENTRIES_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: wave.id,
          timestamp: start,
          vote: 7,
          vote_on_decision_time: 7,
          over_threshold_since_ms: null
        }
      ]
    },
    {
      table: tables.PROFILES_ACTIVITY_LOGS_TABLE,
      rows: [
        {
          id: 'recovery-original-log',
          profile_id: actor,
          target_id: dropId,
          additional_data_1: actor,
          additional_data_2: wave.id,
          proxy_id: proxy,
          type: 'DROP_VOTE_EDIT',
          created_at: new Date(start - day),
          contents: { oldVote: '29', newVote: 7, reason: 'CREDIT_OVERSPENT' }
        }
      ]
    }
  ],
  () => {
    let clock: { value: number };
    let service: CompetitionMigrationService;
    const originalApiBase = process.env.API_BASE_URL;
    const originalMainStage = process.env.MAIN_STAGE_WAVE_ID;
    beforeEach(async () => {
      clock = { value: start + 100 };
      jest.spyOn(Date, 'now').mockImplementation(() => clock.value);
      for (const name of [
        'isUnifiedCompetitionReadsEnabled',
        'isNativeCompetitionWritesEnabled',
        'isNativeCompetitionExecutionEnabled'
      ] as const)
        jest.spyOn(appFeatures, name).mockReturnValue(true);
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue([]);
      jest.spyOn(userNotifier, 'notifyOfDropVote').mockResolvedValue(undefined);
      jest
        .spyOn(pushes, 'sendIdentityPushNotificationsStrict')
        .mockResolvedValue(undefined);
      jest
        .spyOn(wsListenersNotifier, 'notifyAboutDropUpdate')
        .mockResolvedValue(undefined);
      process.env.API_BASE_URL = 'https://example.test/api';
      process.env.MAIN_STAGE_WAVE_ID = wave.id;
      await new CompetitionRepository().ensureLegacyMappingForWave(wave, {});
      await installMigrationCapture(sqlExecutor);
      service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'local'
      );
      await migrate();
    });
    afterEach(() => {
      jest.restoreAllMocks();
      if (originalApiBase === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = originalApiBase;
      if (originalMainStage === undefined)
        delete process.env.MAIN_STAGE_WAVE_ID;
      else process.env.MAIN_STAGE_WAVE_ID = originalMainStage;
    });

    async function migrate() {
      const result = await migrateWave(
        {
          waveId: wave.id,
          environment: 'local',
          operator,
          dryRun: false,
          batch: 10,
          timeoutMs: 60_000
        },
        service,
        {
          now: () => clock.value,
          wait: async (ms) => {
            clock.value += ms;
          },
          progress: () => undefined
        }
      );
      expect(result.status.storageMode).toBe('NATIVE');
    }
    async function vote(
      value: number,
      key = randomUUID(),
      entry = entryId,
      ctx = actorContext
    ) {
      const record =
        (await new CompetitionRepository().findCompetitionRecordById(id, {}))!;
      return competitionVotingService.vote(
        wave.id,
        id,
        entry,
        {
          idempotency_key: key,
          config_version: Number(record.config_version),
          value
        },
        ctx
      );
    }
    async function legacyVote(value: number) {
      return sqlExecutor.executeNativeQueriesInTransaction(
        (connection) =>
          voteForDropUseCase.execute(
            {
              wave_id: wave.id,
              drop_id: dropId,
              voter_id: actor,
              votes: value,
              proxy_id: proxy
            },
            { connection }
          ),
        { isolationLevel: 'READ COMMITTED' }
      );
    }
    const activity = (offset = 0, limit = 50) =>
      listCompetitionVoteActivity(wave.id, id, offset, limit, {});
    const history = () =>
      sqlExecutor.execute(
        `SELECT * FROM ${tables.COMPETITION_VOTE_HISTORY_TABLE} WHERE competition_id=:id ORDER BY sequence`,
        { id }
      );
    const acceptedVote = () =>
      sqlExecutor.execute(
        `SELECT value,credit_spent FROM ${tables.COMPETITION_VOTES_TABLE} WHERE competition_id=:id AND entry_id=:entryId`,
        { id, entryId }
      );

    it.each(['native', 'legacy'] as const)(
      'saves a %s vote without competition-wide work and lets the worker refresh standings',
      async (endpoint) => {
        const budgets = jest.spyOn(competitionCreditService, 'getBudget');
        const voters = jest.spyOn(
          nativeCompetitionRuntimeRepository,
          'listActiveVoters'
        );
        const standings = jest.spyOn(
          nativeCompetitionRuntimeRepository,
          'saveLeaderboard'
        );
        const before = await sqlExecutor.execute(
          `select * from ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id`,
          { id }
        );
        if (endpoint === 'native') {
          await expect(vote(29)).resolves.toMatchObject({
            current_vote: 29,
            spent: 29,
            remaining: 71
          });
        } else {
          await expect(legacyVote(29)).resolves.toBe(true);
        }
        expect(await acceptedVote()).toEqual([{ value: 29, credit_spent: 29 }]);
        expect(
          budgets.mock.calls.every(
            (call) => call[1] === actor && call[3].connection
          )
        ).toBe(true);
        expect(voters).not.toHaveBeenCalled();
        expect(standings).not.toHaveBeenCalled();
        expect(
          await sqlExecutor.execute(
            `select * from ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id`,
            { id }
          )
        ).toEqual(before);
        expect(
          await sqlExecutor.execute(
            `select real_time_rating from ${tables.COMPETITION_ENTRY_RUNTIME_TABLE} where competition_id=:id and entry_id=:entryId`,
            { id, entryId }
          )
        ).toEqual([{ real_time_rating: 29 }]);
        await nativeCompetitionRuntimeService.refreshNativeLeaderboards(
          new Timer('vote-background-refresh'),
          clock.value
        );
        expect(voters).toHaveBeenCalledWith(id, expect.anything());
        expect(standings).toHaveBeenCalled();
        expect(
          await sqlExecutor.execute(
            `select real_time_rating,updated_at from ${tables.COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id and entry_id=:entryId`,
            { id, entryId }
          )
        ).toEqual([{ real_time_rating: 29, updated_at: clock.value }]);
      }
    );

    it.each(['native', 'legacy'] as const)(
      'reconciles reduced credit for the %s voter before validating the replacement',
      async (endpoint) => {
        await sqlExecutor.execute(
          `update ${tables.IDENTITIES_TABLE} set tdh=3 where profile_id=:actor`,
          { actor }
        );
        if (endpoint === 'native') {
          await expect(vote(-2)).resolves.toMatchObject({
            current_vote: -2,
            spent: 2,
            remaining: 1
          });
        } else {
          await expect(legacyVote(-2)).resolves.toBe(true);
        }
        expect(await acceptedVote()).toEqual([{ value: -2, credit_spent: 2 }]);
        expect(await activity()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              contents: { oldVote: 7, newVote: 3, reason: 'CREDIT_OVERSPENT' }
            }),
            expect.objectContaining({ contents: { oldVote: 3, newVote: -2 } })
          ])
        );
      }
    );

    it.each(['native', 'legacy'] as const)(
      'rejects an unaffordable %s vote and rolls back its credit reconciliation',
      async (endpoint) => {
        await sqlExecutor.execute(
          `update ${tables.IDENTITIES_TABLE} set tdh=3 where profile_id=:actor`,
          { actor }
        );
        await expect(
          endpoint === 'native' ? vote(4) : legacyVote(4)
        ).rejects.toThrow();
        expect(await acceptedVote()).toEqual([{ value: 7, credit_spent: 7 }]);
        expect(await history()).toEqual([]);
      }
    );
    async function durableNativeData() {
      const snapshots = [];
      for (const [table, order] of [
        [tables.COMPETITION_ENTRIES_TABLE, 'id'],
        [tables.COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE, 'entry_id,version'],
        [tables.COMPETITION_VOTES_TABLE, 'id'],
        [
          tables.COMPETITION_WINNER_VOTES_TABLE,
          'decision_id,entry_id,voter_profile_id'
        ]
      ]) {
        snapshots.push(
          await sqlExecutor.execute(
            `SELECT * FROM ${table} WHERE competition_id=:id ORDER BY ${order}`,
            { id }
          )
        );
      }
      return snapshots;
    }

    function sinks() {
      const sockets = {
        notifyAboutCompetitionUpdate: jest.fn().mockResolvedValue(undefined)
      };
      const notifier = {
        notifyOfCompetitionLifecycle: jest.fn().mockResolvedValue([])
      };
      const announcements = { drop: jest.fn().mockResolvedValue([]) };
      const claims = new MintingClaimsService(
        dropsDb,
        mintingClaimsDb,
        memeCardDropMappingsDb,
        () => wave.id
      );
      const publishClaim = jest.fn((drop: string, context) =>
        claims.createClaimForDropIfMissing(drop, context)
      );
      const push = jest.fn().mockResolvedValue(undefined);
      const dispatcher = new CompetitionEventDispatcher(
        nativeCompetitionRuntimeRepository,
        competitionEventRepository,
        sockets,
        notifier,
        announcements,
        publishClaim,
        push,
        () => ['local-announcement']
      );
      return {
        dispatcher,
        notifier,
        announcements,
        publishClaim,
        push,
        sockets
      };
    }
    async function reverse(between?: () => Promise<void>) {
      for (let batch = 0; batch < 300; batch++) {
        const status = await service.reverseReconcile(id, operator, 1);
        if (batch === 3) await between?.();
        if (status.migration?.reverse_ready) return;
      }
      throw new Error('Reverse reconciliation did not finish');
    }
    async function submit() {
      const record =
        (await new CompetitionRepository().findCompetitionRecordById(id, {}))!;
      const request: ApiCreateCompetitionEntryRequest = {
        idempotency_key: randomUUID(),
        config_version: Number(record.config_version),
        drop: {
          wave_id: wave.id,
          drop_type: ApiDropType.Participatory,
          title: null,
          parts: [
            {
              content: 'Accepted synthetic signed submission',
              quoted_drop: null,
              media: []
            }
          ],
          metadata: [],
          referenced_nfts: [],
          mentioned_users: [],
          mentioned_waves: [],
          signature: null
        }
      };
      const message = canonicalCompetitionJson({
        domain: '6529-competition-v1',
        audience: 'example.test',
        chain_id: 1,
        action: 'ENTRY_CREATE',
        wave_id: wave.id,
        competition_id: id,
        competition_entry_id: null,
        drop_id: null,
        config_version: request.config_version,
        actor_profile_id: actor,
        actor_wallet: wallet.address.toLowerCase(),
        payload_hash: competitionPayloadHash({
          drop: request.drop,
          drop_id: null
        }),
        nonce: randomUUID(),
        issued_at: clock.value,
        expires_at: clock.value + 300_000
      });
      request.signature = {
        message,
        signature: await wallet.signMessage(message)
      };
      return competitionEntryService.create(wave.id, id, request, actorContext);
    }

    it('retains replacement votes, exact native Activity and original legacy attribution through rollback and another migration', async () => {
      for (const value of [29, 17, -5, 0, -29]) {
        clock.value += 100;
        const key = randomUUID();
        await vote(value, key, entryId, proxyContext);
        await vote(value, key, entryId, proxyContext);
      }
      clock.value += 100;
      expect(await legacyVote(-17)).toBe(true);
      expect(await legacyVote(-17)).toBe(false);
      const original = await activity();
      expect(original).toHaveLength(7);
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${tables.PROFILES_ACTIVITY_LOGS_TABLE} WHERE additional_data_2=:waveId`,
          { waveId: wave.id }
        )
      ).toHaveLength(7);
      expect(new Set(original.map((log) => log.id)).size).toBe(7);
      expect(original.every((log) => log.invoker_proxy?.id === proxy)).toBe(
        true
      );
      expect(original.at(-1)).toMatchObject({
        id: 'recovery-original-log',
        contents: { reason: 'CREDIT_OVERSPENT', oldVote: '29', newVote: 7 }
      });
      const stored = await history();
      const local = sinks();
      // Standings now catch up in the worker before a rollback snapshot is taken.
      await nativeCompetitionRuntimeService.refreshNativeLeaderboards(
        new Timer('recovery-standings'),
        clock.value
      );
      await local.dispatcher.dispatchPending({}, clock.value);
      await reverse(async () => {
        clock.value += 10;
        await vote(-5);
        await nativeCompetitionRuntimeService.refreshNativeLeaderboards(
          new Timer('recovery-concurrent-standings'),
          clock.value
        );
        await local.dispatcher.dispatchPending({}, clock.value);
      });
      expect(await service.rollback(id, operator, false)).toEqual({
        changed: true,
        repairRequired: false
      });
      expect((await service.status(id)).storageMode).toBe('LEGACY_ADAPTER');
      expect(await acceptedVote()).toEqual([{ value: -5, credit_spent: 5 }]);
      expect((await history()).slice(0, stored.length)).toEqual(stored);
      const after = await activity();
      expect(after.slice(1)).toEqual(original);
      const afterHistory = await history();
      // Deliberately stay in the rollback's second. A timestamp-only filter loses this log.
      clock.value += 1;
      expect(await legacyVote(11)).toBe(true);
      const legacy = await activity();
      expect(legacy).toHaveLength(after.length + 1);
      expect(
        legacy.find((log) => !after.some((old) => old.id === log.id))
      ).toMatchObject({
        contents: { oldVote: -5, newVote: 11 },
        invoker_proxy: { id: proxy }
      });
      expect(await history()).toEqual(afterHistory);
      clock.value += 1;
      await service.enroll(id, operator, 'PRIVILEGED');
      let sawShadowReset = false;
      for (let batch = 0; batch < 50; batch++) {
        await service.backfill(id, operator, 100);
        const entries = await sqlExecutor.execute(
          `SELECT id FROM ${tables.COMPETITION_ENTRIES_TABLE} WHERE competition_id=:id`,
          { id }
        );
        if (!entries.length) {
          sawShadowReset = true;
          expect(await activity()).toEqual(legacy);
          break;
        }
      }
      expect(sawShadowReset).toBe(true);
      await migrate();
      expect(await history()).toEqual(afterHistory);
      expect(await activity()).toEqual(legacy);
      const pages = [];
      for (let offset = 0; offset < legacy.length; offset += 2)
        pages.push(...(await activity(offset, 2)));
      expect(pages).toEqual(legacy);
      clock.value += 100;
      await vote(17);
      const remigratedHistory = await history();
      expect(remigratedHistory.slice(0, afterHistory.length)).toEqual(
        afterHistory
      );
      expect(Number(remigratedHistory.at(-1)!.sequence)).toBeGreaterThan(
        Number(afterHistory.at(-1)!.sequence)
      );
      const resumed = await activity();
      const resumedId = `${id}:${remigratedHistory.at(-1)!.sequence}`;
      expect(resumed.filter((log) => log.id !== resumedId)).toEqual(legacy);
      expect(resumed.filter((log) => log.id === resumedId)).toEqual([
        expect.objectContaining({
          id: resumedId,
          contents: { oldVote: 11, newVote: 17 }
        })
      ]);
      expect((await service.verifyNative(id)).failures).toEqual([]);
    }, 120_000);

    it('rolls the entire vote transaction back on an Activity identity collision without overwriting the existing log', async () => {
      await vote(17);
      // This disposable fixture has one writer. A successful insert establishes
      // the next sequence without resetting counters or cached schema metadata.
      const nextSequence = Number((await history()).at(-1)!.sequence) + 1;
      await sqlExecutor.execute(
        `INSERT INTO ${tables.PROFILES_ACTIVITY_LOGS_TABLE}
        (id,profile_id,target_id,additional_data_1,additional_data_2,type,created_at,contents)
        VALUES (:activityId,:actor,:dropId,:actor,:waveId,'DROP_VOTE_EDIT',:createdAt,:contents)`,
        {
          activityId: `${id}:${nextSequence}`,
          actor,
          dropId,
          waveId: wave.id,
          createdAt: new Date(start),
          contents: JSON.stringify({ oldVote: 999, newVote: 998 })
        }
      );
      const snapshot = async () => {
        const rows = [];
        for (const table of [
          tables.COMPETITION_VOTES_TABLE,
          tables.COMPETITION_VOTE_HISTORY_TABLE,
          tables.COMPETITION_ENTRY_RUNTIME_TABLE,
          tables.COMPETITION_COMMANDS_TABLE,
          tables.COMPETITION_OUTBOX_TABLE,
          tables.COMPETITION_LEGACY_MIRROR_PERMITS_TABLE,
          tables.DROP_VOTER_STATE_TABLE,
          tables.DROP_RANK_TABLE,
          tables.DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
          tables.DROP_REAL_VOTE_IN_TIME_TABLE,
          tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
          tables.PROFILES_ACTIVITY_LOGS_TABLE,
          tables.PROFILE_LATEST_LOG_TABLE
        ])
          rows.push(await sqlExecutor.execute(`SELECT * FROM ${table}`));
        return rows;
      };
      const before = await snapshot();
      const key = randomUUID();
      await expect(vote(29, key)).rejects.toThrow('Duplicate entry');
      expect(await snapshot()).toEqual(before);
      expect(await acceptedVote()).toEqual([{ value: 17, credit_spent: 17 }]);
      // The failed command receipt also rolled back; the same key can be retried.
      await vote(29, key);
      expect(await acceptedVote()).toEqual([{ value: 29, credit_spent: 29 }]);
      expect(await history()).toHaveLength(2);
    });

    it('refuses an absent primary Activity target and requires a pinned transaction', async () => {
      const params = {
        competitionId: id,
        entryId: 'missing-entry',
        voterProfileId: actor,
        previousVote: 7,
        value: 29,
        occurredAt: clock.value
      };
      await expect(
        mirrorNativeLegacyVoteActivity(sqlExecutor, params, 1, {})
      ).rejects.toThrow('requires a transaction');
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          mirrorNativeLegacyVoteActivity(sqlExecutor, params, 1, { connection })
        )
      ).rejects.toThrow('requires exactly one Activity log');
      expect(await history()).toEqual([]);
      expect(await acceptedVote()).toEqual([{ value: 7, credit_spent: 7 }]);
    });

    it('requires pending delivery recovery before reversal and rejects a stale reverse snapshot after another accepted vote', async () => {
      await vote(29);
      expect(await service.rollback(id, operator, false)).toMatchObject({
        changed: false,
        repairRequired: true
      });
      await expect(
        service.reviewRepair(
          id,
          operator,
          'https://example.test/synthetic/pending'
        )
      ).rejects.toThrow('Drain pending');
      const local = sinks();
      await nativeCompetitionRuntimeService.refreshNativeLeaderboards(
        new Timer('recovery-standings'),
        clock.value
      );
      await local.dispatcher.dispatchPending({}, clock.value);
      await service.reviewRepair(
        id,
        operator,
        'https://example.test/synthetic/drained'
      );
      await reverse();
      clock.value += 10;
      await vote(-17);
      await local.dispatcher.dispatchPending({}, clock.value);
      const result = await service.rollback(id, operator, false);
      expect(result).toMatchObject({ changed: false, repairRequired: false });
      expect('failures' in result && result.failures?.length).toBeGreaterThan(
        0
      );
      expect((await service.status(id)).storageMode).toBe('NATIVE');
      await nativeCompetitionRuntimeService.refreshNativeLeaderboards(
        new Timer('recovery-latest-standings'),
        clock.value
      );
      await local.dispatcher.dispatchPending({}, clock.value);
      await reverse();
      expect((await service.rollback(id, operator, false)).changed).toBe(true);
      expect(await acceptedVote()).toEqual([{ value: -17, credit_spent: 17 }]);
    }, 120_000);

    it('keeps a TDH reduction, its adjustment reason and spending through rollback', async () => {
      await vote(-29);
      clock.value += 50;
      await sqlExecutor.execute(
        `UPDATE ${tables.IDENTITIES_TABLE} SET tdh=3 WHERE profile_id=:actor`,
        { actor }
      );
      await sqlExecutor.executeNativeQueriesInTransaction(
        (connection) => revokeTdhBasedDropWavesOverVotes(connection),
        { isolationLevel: 'READ COMMITTED' }
      );
      expect(await acceptedVote()).toEqual([{ value: -3, credit_spent: 3 }]);
      const before = await activity();
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${tables.PROFILES_ACTIVITY_LOGS_TABLE} WHERE additional_data_2=:waveId`,
          { waveId: wave.id }
        )
      ).toHaveLength(3);
      expect(before[0].contents).toEqual({
        oldVote: -29,
        newVote: -3,
        reason: 'CREDIT_OVERSPENT'
      });
      const stored = await history();
      await sinks().dispatcher.dispatchPending({}, clock.value);
      await reverse();
      expect((await service.rollback(id, operator, false)).changed).toBe(true);
      expect(await history()).toEqual(stored);
      expect(await activity()).toEqual(before);
      expect(
        await sqlExecutor.execute(
          `SELECT votes FROM ${tables.DROP_VOTER_STATE_TABLE} WHERE wave_id=:waveId`,
          { waveId: wave.id }
        )
      ).toEqual([{ votes: -3 }]);
      expect(
        await sqlExecutor.execute(
          `SELECT SUM(credit_spent) AS spent FROM ${tables.DROPS_VOTES_CREDIT_SPENDINGS_TABLE} WHERE wave_id=:waveId AND voter_id=:actor`,
          { waveId: wave.id, actor }
        )
      ).toEqual([{ spent: 3 }]);
    }, 120_000);

    it('refuses reversal of an accepted signed native submission and records reviewed forward recovery without rewriting it', async () => {
      const entry = await submit();
      expect((await dropsDb.findDropById(entry.drop_id))?.drop_type).toBe(
        'COMPETITION'
      );
      await vote(29, randomUUID(), entry.id);
      const saved = await history();
      const accepted = await durableNativeData();
      await sinks().dispatcher.dispatchPending({}, clock.value);
      await expect(reverse()).rejects.toThrow(
        'cannot change native-created primary drop types'
      );
      await service.recordException(
        id,
        operator,
        'NATIVE_SUBMISSION_REVERSE_REFUSED'
      );
      expect(
        await service.reviewRepair(
          id,
          operator,
          'https://example.test/synthetic/submission-recovery'
        )
      ).toMatchObject({
        ownershipRetained: 'NATIVE',
        rollbackStillGuarded: true
      });
      expect((await service.status(id)).storageMode).toBe('NATIVE');
      expect((await dropsDb.findDropById(entry.drop_id))?.drop_type).toBe(
        'COMPETITION'
      );
      expect(await history()).toEqual(saved);
      expect(await durableNativeData()).toEqual(accepted);
      await expect(reverse()).rejects.toThrow(
        'cannot change native-created primary drop types'
      );
    }, 120_000);

    it('repairs a failed delivery forward after a native decision, with durable effects and a real idempotent local claim consumer', async () => {
      const entry = await submit();
      await vote(29, randomUUID(), entry.id);
      const savedHistory = await history();
      clock.value = start + 2 * day + 1;
      await nativeCompetitionRuntimeService.processCompetition(id, clock.value);
      const decisions = await sqlExecutor.execute(
        `SELECT * FROM ${tables.COMPETITION_DECISIONS_TABLE} WHERE competition_id=:id`,
        { id }
      );
      const winners = await sqlExecutor.execute(
        `SELECT * FROM ${tables.COMPETITION_DECISION_WINNERS_TABLE} WHERE competition_id=:id`,
        { id }
      );
      const accepted = await durableNativeData();
      expect(decisions).toHaveLength(1);
      expect(winners).toHaveLength(1);
      const local = sinks();
      jest.spyOn(safeFetch, 'fetchPublicUrlToBuffer').mockResolvedValue({
        buffer: Buffer.from('{"season":1}'),
        contentType: 'application/json',
        finalUrl: 'https://example.test/calendar'
      });
      // Fail after the real local claim transaction and announcement receipt commit.
      let failPublication = true;
      local.push.mockImplementation(async () => {
        if (local.announcements.drop.mock.calls.length && failPublication) {
          failPublication = false;
          throw new Error('isolated publication sink outage');
        }
      });
      expect(await service.rollback(id, operator, false)).toMatchObject({
        changed: false,
        repairRequired: true
      });
      await local.dispatcher.dispatchPending({}, clock.value);
      const pending = (await service.verifyNative(id)).pendingEffects;
      expect(pending).toBeGreaterThan(0);
      await expect(
        service.reviewRepair(
          id,
          operator,
          'https://example.test/synthetic/too-early'
        )
      ).rejects.toThrow('Drain pending');
      // Restore the sink, honor normal backoff, and use the real outbox retry path.
      clock.value += 3_600_001;
      await local.dispatcher.dispatchPending({}, clock.value);
      expect((await service.verifyNative(id)).pendingEffects).toBe(0);
      await service.reviewRepair(
        id,
        operator,
        'https://example.test/synthetic/forward-delivery-recovery'
      );
      await nativeCompetitionRuntimeService.processCompetition(id, clock.value);
      await local.dispatcher.dispatchPending({}, clock.value);
      expect(
        await sqlExecutor.execute(
          `SELECT * FROM ${tables.COMPETITION_DECISIONS_TABLE} WHERE competition_id=:id`,
          { id }
        )
      ).toEqual(decisions);
      expect(
        await sqlExecutor.execute(
          `SELECT * FROM ${tables.COMPETITION_DECISION_WINNERS_TABLE} WHERE competition_id=:id`,
          { id }
        )
      ).toEqual(winners);
      expect(await history()).toEqual(savedHistory);
      expect(await durableNativeData()).toEqual(accepted);
      expect((await service.status(id)).storageMode).toBe('NATIVE');
      expect(local.announcements.drop).toHaveBeenCalledTimes(1);
      expect(local.notifier.notifyOfCompetitionLifecycle).toHaveBeenCalledTimes(
        1
      );
      expect(local.publishClaim).toHaveBeenCalledTimes(2);
      expect(
        await sqlExecutor.execute(
          `SELECT competition_id,entry_id,decision_id FROM ${tables.COMPETITION_CLAIMS_TABLE} WHERE competition_id=:id`,
          { id }
        )
      ).toEqual([
        { competition_id: id, entry_id: entry.id, decision_id: decisions[0].id }
      ]);
      expect(
        await sqlExecutor.execute(
          `SELECT drop_id FROM ${tables.MINTING_CLAIMS_TABLE}`
        )
      ).toEqual([{ drop_id: entry.drop_id }]);
      expect((await service.verifyNative(id)).failures).toEqual([]);
      expect(await service.rollback(id, operator, false)).toMatchObject({
        changed: false,
        repairRequired: true
      });
    }, 120_000);
  }
);
