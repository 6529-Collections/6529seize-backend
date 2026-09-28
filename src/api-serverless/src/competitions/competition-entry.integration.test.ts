import { randomUUID } from 'node:crypto';
import { Wallet } from 'ethers';
import { AuthenticationContext } from '@/auth-context';
import { appFeatures } from '@/app-features';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { competitionEntryService as service } from './competition-entry.service';
import { competitionEntryRepository as repository } from '@/competitions/competition-entry.repository';
import { competitionEntryDropHooks as hooks } from '@/competitions/competition-entry-drop-hooks';
import {
  canonicalCompetitionJson,
  competitionPayloadHash
} from '@/competitions/competition-command-identity';
import { competitionCreditService } from '@/competitions/competition-credit.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { sqlExecutor } from '@/sql-executor';
import * as tables from '@/constants';
import { dropsDb } from '@/drops/drops.db';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { prePublicationModerationService } from '@/content-moderation/pre-publication-moderation.service';
import { ApiCreateCompetitionEntryRequest } from '@/api/generated/models/ApiCreateCompetitionEntryRequest';
import { moderationFingerprint } from '@/content-moderation/moderation-review.types';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import { NotFoundException } from '@/exceptions';
import { competitionVotingService } from './competition-voting.service';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import * as pushNotifications from '@/api/push-notifications/push-notifications.service';

const actor = 'entry-author';
const wallet = Wallet.createRandom();
const competitionId = '10000000-0000-4000-8000-000000000001';
const wave = aWave(
  { created_by: 'admin', chat_enabled: false, chat_group_id: 'chat-only' },
  { id: 'entry-hub', name: 'Entry hub' }
);
const privateParent = aWave(
  { visibility_group_id: 'private-parent-members' },
  { id: 'entry-private-parent', name: 'Private parent' }
);
const otherWave = aWave({}, { id: 'entry-other-hub', name: 'Other hub' });
const ctx = {
  authenticationContext: new AuthenticationContext({
    authenticatedWallet: wallet.address,
    authenticatedProfileId: actor,
    roleProfileId: null,
    activeProxyActions: []
  })
};
const participation = {
  group_id: null,
  signature_required: false,
  max_entries_per_participant: null,
  required_metadata: [],
  required_media: [],
  submission_type: null,
  identity_submission_strategy: null,
  identity_submission_duplicates: null,
  starts_at: null,
  ends_at: null,
  terms: null
};
const record = {
  id: competitionId,
  wave_id: wave.id,
  storage_mode: 'NATIVE',
  legacy_wave_id: null,
  execution_mode: 'ACTIVE',
  type: 'RANK',
  lifecycle: 'PUBLISHED',
  title: 'Entry fixture',
  participation_config: participation,
  voting_config: {
    group_id: null,
    credit_type: 'TDH',
    credit_scope: 'WAVE',
    credit_category: null,
    credit_creditor: null,
    credit_nfts: [],
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
};
const request = (dropId = 'content-a'): ApiCreateCompetitionEntryRequest => ({
  idempotency_key: randomUUID(),
  config_version: 1,
  drop_id: dropId
});
async function updateParticipation(patch: Record<string, unknown>) {
  await sqlExecutor.execute(
    `update ${tables.COMPETITIONS_TABLE} set participation_config=:config where id=:id`,
    {
      id: competitionId,
      config: JSON.stringify({ ...participation, ...patch })
    }
  );
}
async function signedRequest(): Promise<ApiCreateCompetitionEntryRequest> {
  const input = request();
  input.drop_content_hash = competitionPayloadHash(
    await service.getCandidateContent(
      wave.id,
      competitionId,
      input.drop_id!,
      ctx
    )
  );
  const now = Date.now();
  const message = canonicalCompetitionJson({
    domain: '6529-competition-v1',
    audience: 'api.6529.io',
    chain_id: 1,
    action: 'ENTRY_CREATE',
    wave_id: wave.id,
    competition_id: competitionId,
    competition_entry_id: null,
    drop_id: input.drop_id,
    config_version: 1,
    actor_profile_id: actor,
    actor_wallet: wallet.address.toLowerCase(),
    payload_hash: competitionPayloadHash({
      drop: null,
      drop_id: input.drop_id,
      drop_content_hash: input.drop_content_hash
    }),
    nonce: randomUUID(),
    issued_at: now,
    expires_at: now + 300000
  });
  return {
    ...input,
    signature: { message, signature: await wallet.signMessage(message) }
  };
}
async function model(dropId: string): Promise<CreateOrUpdateDropModel> {
  const drop = (await dropsDb.findDropById(dropId))!;
  return {
    ...(await repository.loadDropContent(drop, {})),
    drop_id: dropId,
    author_identity: actor,
    author_id: actor,
    signature: null,
    drop_type: DropType.CHAT,
    is_additional_action_promised: null
  };
}

describeWithSeed(
  'Native entry commands and content history',
  [
    withWaves([wave, privateParent, otherWave]),
    withProfiles([
      aProfile({
        external_id: actor,
        handle: 'entrant',
        primary_wallet: wallet.address
      })
    ]),
    withIdentities([
      anIdentity(
        { tdh: 100 },
        {
          profile_id: actor,
          consolidation_key: wallet.address,
          primary_address: wallet.address,
          handle: 'entrant'
        }
      )
    ]),
    { table: tables.COMPETITIONS_TABLE, rows: [record] },
    {
      table: tables.DROPS_TABLE,
      rows: ['content-a', 'content-b'].map((id) => ({
        id,
        wave_id: wave.id,
        author_id: actor,
        created_at: 1,
        parts_count: 1,
        drop_type: 'CHAT'
      }))
    },
    {
      table: tables.DROPS_PARTS_TABLE,
      rows: ['content-a', 'content-b'].map((id) => ({
        drop_id: id,
        wave_id: wave.id,
        drop_part_id: 1,
        content: 'Original content'
      }))
    }
  ],
  () => {
    let originalApiBaseUrl: string | undefined;
    beforeEach(() => {
      originalApiBaseUrl = process.env.API_BASE_URL;
      process.env.API_BASE_URL = 'https://api.6529.io/api';
      jest
        .spyOn(appFeatures, 'isUnifiedCompetitionReadsEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionWritesEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionExecutionEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue([]);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = originalApiBaseUrl;
    });

    it('masks cross-wave content routes and a private parent from anonymous readers', async () => {
      const entry = await service.create(
        wave.id,
        competitionId,
        request(),
        ctx
      );
      expect(
        await service.getContent(wave.id, competitionId, entry.id, {})
      ).toMatchObject({
        parts: [{ content: 'Original content' }],
        signature: null
      });
      await expect(
        service.getContent(otherWave.id, competitionId, entry.id, {})
      ).rejects.toBeInstanceOf(NotFoundException);
      await sqlExecutor.execute(
        `update ${tables.WAVES_TABLE} set parent_wave_id=:parentId where id=:waveId`,
        { parentId: privateParent.id, waveId: wave.id }
      );
      await expect(
        service.getContent(wave.id, competitionId, entry.id, {})
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await repository.getContent(entry.id, {})).not.toBeNull();
    });

    it('does not return a moderated snapshot to an anonymous reader', async () => {
      const entry = await service.create(
        wave.id,
        competitionId,
        request(),
        ctx
      );
      await sqlExecutor.execute(
        `insert into ${tables.CONTENT_MODERATION_DROP_STATES_TABLE} (drop_id,status,updated_at) values (:dropId,'MODERATOR_REMOVED',1)`,
        { dropId: entry.drop_id }
      );
      await expect(
        service.getContent(wave.id, competitionId, entry.id, {})
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await repository.getContent(entry.id, {})).not.toBeNull();
    });

    it('keeps maximum-safe sign switches exact in votes, history and Main Stage metrics', async () => {
      const entry = await service.create(
        wave.id,
        competitionId,
        request(),
        ctx
      );
      const maximum = Number.MAX_SAFE_INTEGER;
      await sqlExecutor.execute(
        `update ${tables.IDENTITIES_TABLE} set tdh=:maximum where profile_id=:actor`,
        { maximum, actor }
      );
      await sqlExecutor.execute(
        `insert into ${tables.COMPETITION_CAPABILITIES_TABLE} (capability,competition_id,wave_id,assigned_at) values ('MAIN_STAGE',:competitionId,:waveId,1)`,
        { competitionId, waveId: wave.id }
      );
      for (const value of [maximum, 1 - maximum, maximum]) {
        const budget = await competitionVotingService.vote(
          wave.id,
          competitionId,
          entry.id,
          {
            idempotency_key: randomUUID(),
            config_version: 1,
            value
          },
          ctx
        );
        expect(budget.current_vote).toBe(value);
        expect(budget.spent).toBe(Math.abs(value));
        const [metric] = await sqlExecutor.execute<{ value: string }>(
          `select cast(value_sum as char) as value from ${tables.METRIC_ROLLUP_HOUR_TABLE} where metric='MAIN_STAGE_VOTE' and scope=:actor`,
          { actor }
        );
        expect(metric.value).toBe(String(value));
      }
      expect(
        await sqlExecutor.execute(
          `select cast(previous_value as char) as previous_value,cast(value as char) as value,cast(credit_delta as char) as credit_delta from ${tables.COMPETITION_VOTE_HISTORY_TABLE} where entry_id=:entryId order by sequence`,
          { entryId: entry.id }
        )
      ).toEqual([
        {
          previous_value: '0',
          value: String(maximum),
          credit_delta: String(maximum)
        },
        {
          previous_value: String(maximum),
          value: String(1 - maximum),
          credit_delta: '-1'
        },
        {
          previous_value: String(1 - maximum),
          value: String(maximum),
          credit_delta: '1'
        }
      ]);
    });

    it('rolls back newly created content when the entry snapshot cannot be saved', async () => {
      jest
        .spyOn(prePublicationModerationService, 'evaluate')
        .mockResolvedValue(undefined);
      jest
        .spyOn(repository, 'saveContent')
        .mockRejectedValue(new Error('snapshot failure'));
      await expect(
        service.create(
          wave.id,
          competitionId,
          {
            idempotency_key: randomUUID(),
            config_version: 1,
            drop: {
              wave_id: wave.id,
              drop_type: ApiDropType.Chat,
              title: null,
              parts: [{ content: 'Rolled back', quoted_drop: null, media: [] }],
              metadata: [],
              referenced_nfts: [],
              mentioned_users: [],
              mentioned_waves: [],
              signature: null
            }
          },
          ctx
        )
      ).rejects.toThrow('snapshot failure');
      expect(
        await sqlExecutor.execute(`select id from ${tables.DROPS_TABLE}`)
      ).toHaveLength(2);
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_ENTRIES_TABLE}`
        )
      ).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_COMMANDS_TABLE}`
        )
      ).toEqual([]);
    });

    it('applies signed entry guards and unsigned revisions to link-preview changes', async () => {
      const signed = await service.create(
        wave.id,
        competitionId,
        await signedRequest(),
        ctx
      );
      await expect(
        dropCreationService.toggleHideLinkPreview(
          { dropId: signed.drop_id, hideLinkPreview: true },
          ctx
        )
      ).rejects.toThrow('cannot be edited');
      const unsigned = await service.create(
        wave.id,
        competitionId,
        request('content-b'),
        ctx
      );
      await dropCreationService.toggleHideLinkPreview(
        { dropId: unsigned.drop_id, hideLinkPreview: true },
        ctx
      );
      expect(await repository.getContent(unsigned.id, {})).toMatchObject({
        hide_link_preview: true
      });
      expect(
        await sqlExecutor.execute(
          `select version from ${tables.COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} where entry_id=:id order by version`,
          { id: unsigned.id }
        )
      ).toEqual([{ version: 1 }, { version: 2 }]);
    });

    it('detects a newly attached membership after a repeatable-read edit snapshot', async () => {
      let observed!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = repository.findDropEntries.bind(repository);
      jest
        .spyOn(repository, 'findDropEntries')
        .mockImplementationOnce(async (dropId, tx) => {
          const entries = await original(dropId, tx);
          observed();
          await gate;
          return entries;
        });
      const mutation = sqlExecutor.executeNativeQueriesInTransaction(
        (connection) =>
          repository.lockDropMemberships('content-a', { ...ctx, connection })
      );
      const rejected = expect(mutation).rejects.toThrow('membership changed');
      await started;
      try {
        await service.create(wave.id, competitionId, request(), ctx);
      } finally {
        release();
      }
      await rejected;
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_ENTRIES_TABLE}`
        )
      ).toHaveLength(1);
    });

    it('serializes active associations and preserves a native winner when reused in a new destination', async () => {
      const other = '10000000-0000-4000-8000-000000000002';
      await sqlExecutor.execute(
        `insert into ${tables.COMPETITIONS_TABLE} (id,wave_id,storage_mode,execution_mode,type,lifecycle,title,participation_config,voting_config,decision_config,winner_config,outcome_config,config_version,created_at,updated_at,published_at)
        select :other,wave_id,storage_mode,execution_mode,type,lifecycle,title,participation_config,voting_config,decision_config,winner_config,outcome_config,config_version,created_at,updated_at,published_at from ${tables.COMPETITIONS_TABLE} where id=:competitionId`,
        { other, competitionId }
      );
      const attempts = await Promise.allSettled([
        service.create(wave.id, competitionId, request(), ctx),
        service.create(wave.id, other, request(), ctx)
      ]);
      expect(
        attempts.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1);
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_ENTRIES_TABLE}`
        )
      ).toHaveLength(1);
      const [first] = await sqlExecutor.execute<{
        id: string;
        competition_id: string;
      }>(`select id,competition_id from ${tables.COMPETITION_ENTRIES_TABLE}`);
      const original = await repository.getContent(first.id, {});
      await sqlExecutor.execute(
        `update ${tables.COMPETITION_ENTRIES_TABLE} set status='WINNER', \`rank\`=1, won_at=123 where id=:id`,
        { id: first.id }
      );
      const destination =
        first.competition_id === competitionId ? other : competitionId;
      const second = await service.create(wave.id, destination, request(), ctx);
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('ACTIVE');
      expect(
        await competitionRepository.findNativeEntry(
          first.competition_id,
          first.id,
          {}
        )
      ).toMatchObject({ status: 'WINNER', rank: 1, won_at: 123 });
      expect(await repository.getContent(first.id, {})).toEqual(original);
      await expect(
        dropCreationService.toggleHideLinkPreview(
          { dropId: second.drop_id, hideLinkPreview: true },
          ctx
        )
      ).rejects.toThrow('winner content');
      await sqlExecutor.execute(
        `update ${tables.DROPS_TABLE} set drop_type='WINNER' where id='content-b'`
      );
      await expect(
        service.create(wave.id, destination, request('content-b'), ctx)
      ).rejects.toThrow('Only your own chat drop');
    });

    it('keeps historical moderation suppression after a withdrawn drop is edited', async () => {
      const entry = await service.create(
        wave.id,
        competitionId,
        request(),
        ctx
      );
      await service.action(
        wave.id,
        competitionId,
        entry.id,
        'withdraw',
        { idempotency_key: randomUUID(), config_version: 1 },
        ctx
      );
      const content = (await repository.getContent(entry.id, {}))!;
      const revision = moderationFingerprint({
        title: content.title,
        parts: content.parts.map((part) => ({ content: part.content }))
      });
      await sqlExecutor.execute(
        `insert into ${tables.CONTENT_MODERATION_ITEMS_TABLE} (id,subject_type,subject_id,operation,policy_family,policy_version,content_fingerprint,scope,outcome,\`trigger\`,review_status,suppressed,created_at,updated_at)
        values (:id,'DROP',:dropId,'REPORT','WAVE_CONTENT','test',:revision,:scope,'ALLOW','REPORT','REVIEWED',true,1,1)`,
        {
          id: 'a'.repeat(64),
          dropId: entry.drop_id,
          revision,
          scope: JSON.stringify({ published_revision: revision })
        }
      );
      await sqlExecutor.execute(
        `update ${tables.DROPS_PARTS_TABLE} set content='New shared chat' where drop_id=:dropId`,
        { dropId: entry.drop_id }
      );
      await expect(
        service.getContent(wave.id, competitionId, entry.id, ctx)
      ).rejects.toThrow('unavailable');
      await expect(
        service.getContent(wave.id, competitionId, entry.id, {})
      ).rejects.toThrow('unavailable');
      expect(await repository.getContent(entry.id, {})).toMatchObject({
        parts: [{ content: 'Original content' }]
      });
    });

    it('serializes IDENTITY duplicate rules using normalized entry snapshots', async () => {
      await updateParticipation({
        submission_type: 'IDENTITY',
        identity_submission_strategy: 'ONLY_MYSELF',
        identity_submission_duplicates: 'NEVER_ALLOW'
      });
      await sqlExecutor.execute(
        `insert into ${tables.DROP_METADATA_TABLE} (drop_id,data_key,data_value) values ('content-a','identity','entrant'),('content-b','identity','entrant')`
      );
      const attempts = await Promise.allSettled([
        service.create(wave.id, competitionId, request(), ctx),
        service.create(wave.id, competitionId, request('content-b'), ctx)
      ]);
      expect(
        attempts.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1);
      const [entry] = await sqlExecutor.execute<{ id: string }>(
        `select id from ${tables.COMPETITION_ENTRIES_TABLE}`
      );
      expect(await repository.getContent(entry.id, {})).toMatchObject({
        metadata: [{ data_key: 'identity', data_value: actor }]
      });
      expect(
        await sqlExecutor.execute(
          `select data_value from ${tables.DROP_METADATA_TABLE}`
        )
      ).toEqual([{ data_value: 'entrant' }, { data_value: 'entrant' }]);
    });

    it('atomically creates new signed CHAT content through moderation despite chat-only restrictions', async () => {
      const execute = createOrUpdateDrop.execute.bind(createOrUpdateDrop);
      jest
        .spyOn(createOrUpdateDrop, 'execute')
        .mockImplementation(async (...args) => ({
          ...(await execute(...args)),
          pending_push_notification_ids: [101, 102]
        }));
      jest
        .spyOn(pushNotifications, 'sendIdentityPushNotifications')
        .mockResolvedValue(undefined);
      const evaluate = jest
        .spyOn(prePublicationModerationService, 'evaluate')
        .mockResolvedValue(undefined);
      const input: ApiCreateCompetitionEntryRequest = {
        idempotency_key: randomUUID(),
        config_version: 1,
        drop: {
          wave_id: wave.id,
          drop_type: ApiDropType.Chat,
          title: '  Entry title  ',
          parts: [
            {
              content: 'A signed native submission',
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
      const original = JSON.parse(JSON.stringify(input.drop));
      const now = Date.now();
      const message = canonicalCompetitionJson({
        domain: '6529-competition-v1',
        audience: 'api.6529.io',
        chain_id: 1,
        action: 'ENTRY_CREATE',
        wave_id: wave.id,
        competition_id: competitionId,
        competition_entry_id: null,
        drop_id: null,
        config_version: 1,
        actor_profile_id: actor,
        actor_wallet: wallet.address.toLowerCase(),
        payload_hash: competitionPayloadHash({
          drop: input.drop,
          drop_id: null
        }),
        nonce: randomUUID(),
        issued_at: now,
        expires_at: now + 300000
      });
      input.signature = {
        message,
        signature: await wallet.signMessage(message)
      };
      const entry = await service.create(wave.id, competitionId, input, ctx);
      const event = await sqlExecutor.oneOrNull<{ event: string }>(
        `select event from ${tables.COMPETITION_OUTBOX_TABLE} where competition_id=:competitionId and semantic_key=:semanticKey`,
        {
          competitionId,
          semanticKey: `${competitionId}:entry:${input.idempotency_key}`
        }
      );
      expect(JSON.parse(event!.event)).toMatchObject({
        event_type: 'COMPETITION_ENTRY_CREATED',
        competition_entry_id: entry.id,
        data: { pending_push_notification_ids: [101, 102] }
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(input.drop).toEqual(original);
      const drop = (await dropsDb.findDropById(entry.drop_id))!;
      expect(drop).toMatchObject({
        drop_type: 'CHAT',
        title: 'Entry title',
        signature: null
      });
      const replay = await service.create(wave.id, competitionId, input, ctx);
      expect(replay).toEqual(entry);
      expect(evaluate).toHaveBeenCalledTimes(1);
      const stored = await sqlExecutor.oneOrNull<{
        signed_payload: string;
        signed_content: string;
      }>(
        `select signed_payload,signed_content from ${tables.COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} where entry_id=:id`,
        { id: entry.id }
      );
      expect(JSON.parse(stored!.signed_payload)).toEqual({
        drop: original,
        drop_id: null
      });
      expect(JSON.parse(stored!.signed_content)).toEqual(original);
    });

    it('serializes duplicate retries, retains CHAT content and exposes no signature fields', async () => {
      const input = await signedRequest();
      const [first, retry] = await Promise.all([
        service.create(wave.id, competitionId, input, ctx),
        service.create(wave.id, competitionId, input, ctx)
      ]);
      expect(retry).toEqual(first);
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_ENTRIES_TABLE}`
        )
      ).toHaveLength(1);
      expect(
        await sqlExecutor.execute(
          `select version from ${tables.COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE}`
        )
      ).toEqual([{ version: 1 }]);
      const content = await service.getContent(
        wave.id,
        competitionId,
        first.id,
        ctx
      );
      expect(content.signature).toBeNull();
      expect(content).not.toHaveProperty('signer_address');
      expect(content).not.toHaveProperty('signed_payload');
      expect(competitionPayloadHash(content)).toBe(input.drop_content_hash);
      expect((await dropsDb.findDropById(first.drop_id))!.drop_type).toBe(
        'CHAT'
      );
      const editable = await model(first.drop_id);
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          hooks.prepareUpdate(editable, async () => {}, { ...ctx, connection })
        )
      ).rejects.toThrow('cannot be edited');
    });

    it('checks the signed existing content hash under lock and rolls back the command and nonce', async () => {
      const input = await signedRequest();
      await sqlExecutor.execute(
        `update ${tables.DROPS_PARTS_TABLE} set content='Changed' where drop_id='content-a'`
      );
      await expect(
        service.create(wave.id, competitionId, input, ctx)
      ).rejects.toThrow('Drop content changed');
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_COMMANDS_TABLE}`
        )
      ).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_SIGNATURE_NONCES_TABLE}`
        )
      ).toEqual([]);
    });

    it('serializes participant limits and competing active associations', async () => {
      await updateParticipation({ max_entries_per_participant: 1 });
      const attempts = await Promise.allSettled([
        service.create(wave.id, competitionId, request(), ctx),
        service.create(wave.id, competitionId, request('content-b'), ctx)
      ]);
      expect(
        attempts.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1);
      expect(
        attempts.filter((result) => result.status === 'rejected')
      ).toHaveLength(1);
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_ENTRIES_TABLE}`
        )
      ).toHaveLength(1);
    });

    it('enforces current participation eligibility, posting suspension and required content', async () => {
      await updateParticipation({ group_id: 'members' });
      await expect(
        service.create(wave.id, competitionId, request(), ctx)
      ).rejects.toThrow('not eligible');
      await updateParticipation({ required_media: ['IMAGE'] });
      await expect(
        service.create(wave.id, competitionId, request(), ctx)
      ).rejects.toThrow('media of type IMAGE');
      await updateParticipation({});
      jest
        .spyOn(prePublicationModerationService, 'assertPostingAllowed')
        .mockRejectedValue(new Error('posting suspended'));
      await expect(
        service.create(wave.id, competitionId, request(), ctx)
      ).rejects.toThrow('posting suspended');
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.COMPETITION_ENTRIES_TABLE}`
        )
      ).toEqual([]);
    });

    it('preserves vote history while withdrawal releases the budget and keeps the last content revision', async () => {
      const entry = await service.create(
        wave.id,
        competitionId,
        request(),
        ctx
      );
      await sqlExecutor.execute(
        `insert into ${tables.COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) values (:id,:competitionId,:entryId,:actor,70,70,1,1)`,
        { id: randomUUID(), competitionId, entryId: entry.id, actor }
      );
      const current = (await competitionRepository.findCompetitionRecordById(
        competitionId,
        {}
      ))!;
      const competition = await new NativeCompetitionReader(
        competitionRepository,
        {}
      ).getCompetition(current, Date.now());
      expect(
        await competitionCreditService.getBudget(
          competition,
          actor,
          undefined,
          {}
        )
      ).toMatchObject({ spent: 70, remaining: 30 });
      const action = { idempotency_key: randomUUID(), config_version: 1 };
      expect(
        await service.action(
          wave.id,
          competitionId,
          entry.id,
          'withdraw',
          action,
          ctx
        )
      ).toMatchObject({ status: 'WITHDRAWN' });
      expect(
        await service.action(
          wave.id,
          competitionId,
          entry.id,
          'withdraw',
          action,
          ctx
        )
      ).toMatchObject({ status: 'WITHDRAWN' });
      expect(
        await competitionCreditService.getBudget(
          competition,
          actor,
          undefined,
          {}
        )
      ).toMatchObject({ spent: 0, remaining: 100 });
      expect(
        await sqlExecutor.execute(
          `select value from ${tables.COMPETITION_VOTES_TABLE}`
        )
      ).toEqual([{ value: 70 }]);
      const editable = await model(entry.drop_id);
      const edit = await sqlExecutor.executeNativeQueriesInTransaction(
        (connection) =>
          hooks.prepareUpdate(editable, async () => {}, { ...ctx, connection }),
        { isolationLevel: 'READ COMMITTED' }
      );
      expect(edit.entries).toEqual([]);
      expect(await repository.getContent(entry.id, {})).toMatchObject({
        parts: [{ content: 'Original content' }]
      });
    });

    it('snapshots unsigned edits and deletion without exposing deleted content or erasing votes', async () => {
      const entry = await service.create(
        wave.id,
        competitionId,
        request(),
        ctx
      );
      const editable = await model(entry.drop_id);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const tx = { ...ctx, connection };
          const edit = await hooks.prepareUpdate(editable, async () => {}, tx);
          await sqlExecutor.execute(
            `update ${tables.DROPS_PARTS_TABLE} set content='Revision two' where drop_id=:id`,
            { id: entry.drop_id },
            { wrappedConnection: connection }
          );
          await hooks.recordUpdate(
            edit,
            (await dropsDb.findDropById(entry.drop_id, connection))!,
            actor,
            tx
          );
        },
        { isolationLevel: 'READ COMMITTED' }
      );
      expect(await repository.getContent(entry.id, {})).toMatchObject({
        parts: [{ content: 'Revision two' }]
      });
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const tx = { ...ctx, connection };
          const entries = await hooks.lockForDelete(entry.drop_id, tx);
          await hooks.beforeDelete(
            (await dropsDb.findDropById(entry.drop_id, connection))!,
            entries,
            actor,
            tx
          );
          await sqlExecutor.execute(
            `delete from ${tables.DROPS_TABLE} where id=:id`,
            { id: entry.drop_id },
            { wrappedConnection: connection }
          );
        },
        { isolationLevel: 'READ COMMITTED' }
      );
      expect(
        await competitionRepository.findNativeEntry(competitionId, entry.id, {})
      ).toMatchObject({ status: CompetitionEntryStatus.DISQUALIFIED });
      expect(
        await sqlExecutor.execute(
          `select version from ${tables.COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} order by version`
        )
      ).toEqual([{ version: 1 }, { version: 2 }]);
      await expect(
        service.getContent(wave.id, competitionId, entry.id, ctx)
      ).rejects.toThrow('deleted');
    });
  }
);
