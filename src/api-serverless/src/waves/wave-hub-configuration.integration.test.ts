import { ApiCreateNewWave } from '@/api/generated/models/ApiCreateNewWave';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveMetadataType } from '@/api/generated/models/ApiWaveMetadataType';
import { ApiWaveParticipationRequirement } from '@/api/generated/models/ApiWaveParticipationRequirement';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import { ApiUpdateWaveRequest } from '@/api/generated/models/ApiUpdateWaveRequest';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { UpdateWaveSchema, WaveSchema } from './wave-write.schemas';
import {
  DROPS_TABLE,
  MEMES_CONTRACT,
  WAVES_ARCHIVE_TABLE,
  WAVES_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE
} from '@/constants';
import { AuthenticationContext } from '@/auth-context';
import {
  RETIRED_WAVE_COMPETITION_COLUMNS,
  installLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { DropsDb } from '@/drops/drops.db';
import * as Entities from '@/entities/entities';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { WaveCreditType, WaveEntity } from '@/entities/IWave';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { Timer } from '@/time';
import { DataSource } from 'typeorm';
import { WaveApiService } from './wave.api.service';
import { WavesApiDb } from './waves.api.db';
import { WavesMappers } from './waves.mappers';

jest.mock('@/api/waves/wave-score.service', () => ({
  waveScoreService: {
    requestWaveScoreRefreshBestEffort: jest.fn().mockResolvedValue(undefined)
  },
  WaveScoreDirtyRefreshReason: { DROP_CHANGED: 'DROP_CHANGED' }
}));
jest.mock('@/api/waves/wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForWave: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: jest.fn().mockResolvedValue(undefined)
}));

function chatRequest(): ApiCreateNewWave {
  return getValidatedByJoiOrThrow(
    {
      name: 'Private shared chat',
      picture: null,
      description_drop: {
        title: null,
        signature: null,
        parts: [
          { content: 'A shared conversation', quoted_drop: null, media: [] }
        ],
        referenced_nfts: [],
        mentioned_users: [],
        metadata: []
      },
      visibility: { scope: { group_id: 'viewers' } },
      chat: { scope: { group_id: 'chatters' }, enabled: true },
      participation: {
        scope: { group_id: 'participants' },
        no_of_applications_allowed_per_participant: 3,
        required_metadata: [
          { name: 'title', type: ApiWaveMetadataType.String }
        ],
        required_media: [ApiWaveParticipationRequirement.Image],
        signature_required: true,
        period: { min: 1_790_000_000_001, max: null },
        terms: 'Accepted shared hub terms',
        submission_strategy: null
      },
      voting: {
        scope: { group_id: 'voters' },
        credit_type: ApiWaveCreditType.TdhPlusXtdh,
        credit_scope: ApiWaveCreditScope.Drop,
        credit_category: null,
        credit_nfts: null,
        creditor_id: null,
        signature_required: false,
        period: { min: 1_790_000_000_002, max: null },
        forbid_negative_votes: true
      },
      wave: {
        type: ApiWaveType.Chat,
        winning_threshold: null,
        max_winners: null,
        max_votes_per_identity_to_drop: null,
        time_lock_ms: null,
        admin_group: { group_id: 'admins' },
        decisions_strategy: null,
        admin_drop_deletion_enabled: true
      },
      outcomes: []
    },
    WaveSchema
  );
}

function validateUpdate(request: ApiUpdateWaveRequest): ApiUpdateWaveRequest {
  return getValidatedByJoiOrThrow(
    {
      name: request.name,
      picture: request.picture,
      voting: request.voting,
      visibility: request.visibility,
      participation: request.participation,
      chat: request.chat,
      wave: request.wave
    },
    UpdateWaveSchema
  );
}

const repo = new WavesApiDb(() => sqlExecutor);
const mapper = new WavesMappers({} as never, {} as never, repo, {} as never);

function serviceHarness() {
  const groupIds = [
    'viewers',
    'chatters',
    'admins',
    'participants',
    'voters',
    'dm-members'
  ];
  const groups = {
    getApiGroupsByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id }))
    ),
    findGroupIdsWithMembersOutsideContainingGroup: jest
      .fn()
      .mockResolvedValue([]),
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(groupIds),
    getGroupsUserIsEligibleForByIds: jest.fn(
      async (_profile: string, ids: string[]) => ids
    ),
    findFollowersOfUserInGroups: jest.fn().mockResolvedValue([]),
    findIdentitiesInGroups: jest.fn().mockResolvedValue([]),
    onWaveRelatedGroupsChanged: jest.fn().mockResolvedValue(undefined)
  };
  const apiMapper = new WavesMappers(
    {} as never,
    groups as never,
    repo,
    {} as never
  );
  jest.spyOn(apiMapper as never, 'getRelatedData').mockImplementation((async (
    waves: WaveEntity[],
    _groups: string[],
    ctx: RequestContext
  ) => ({
    contributors: {},
    profiles: { creator: { id: 'creator' } },
    curations: Object.fromEntries(groupIds.map((id) => [id, { id }])),
    displayByWaveId: {},
    creationDrops: Object.fromEntries(
      waves.map((wave) => [
        wave.description_drop_id,
        { id: wave.description_drop_id }
      ])
    ),
    subscribedActions: {},
    metrics: Object.fromEntries(
      waves.map((wave) => [
        wave.id,
        {
          wave_id: wave.id,
          drops_count: 1,
          subscribers_count: 1,
          latest_drop_timestamp: 100
        }
      ])
    ),
    authenticatedUserMetrics: {},
    authenticatedUserReaderMetrics: {},
    chatDropCooldowns: {},
    yourParticipationDropsCountByWaveId: {},
    yourUnreadDropsCountByWaveId: {},
    firstUnreadDropSerialNoByWaveId: {},
    wavePauses: {},
    decisionsDoneByWaveId: {},
    votingCreditNftsByWaveId: await repo.findWaveVotingCreditNftsByWaveIds(
      waves.map((wave) => wave.id),
      ctx.connection
    ),
    pinnedWaveIds: new Set(),
    identityWaveIds: new Set(),
    parentWaveOverviewsByChildWaveId: {},
    waveIdsWithVisibleSubwaves: new Set(),
    authenticatedUserId: 'creator'
  })) as never);
  const service = new WaveApiService(
    repo,
    groups as never,
    apiMapper,
    { recordWaveCreated: jest.fn() } as never,
    { addIdentitySubscription: jest.fn() } as never,
    {
      preparePrePublication: jest.fn().mockResolvedValue({}),
      execute: async (
        model: { wave_id: string },
        _description: boolean,
        ctx: RequestContext
      ) => {
        const dropId = `${model.wave_id}-description`;
        await sqlExecutor.bulkInsert(
          DROPS_TABLE,
          [
            {
              id: dropId,
              wave_id: model.wave_id,
              author_id: 'creator',
              created_at: 100,
              parts_count: 1,
              drop_type: 'CHAT'
            }
          ],
          [
            'id',
            'wave_id',
            'author_id',
            'created_at',
            'parts_count',
            'drop_type'
          ],
          ctx
        );
        return { drop_id: dropId, pending_push_notification_ids: [] };
      }
    } as never,
    {
      createDropApiToUseCaseModel: ({
        request
      }: {
        request: { wave_id: string };
      }) => ({ wave_id: request.wave_id })
    } as never,
    {} as never,
    {} as never,
    { notifyOfWaveCreated: jest.fn() } as never,
    {} as never,
    { recordActiveIdentity: jest.fn() } as never,
    {} as never,
    {} as never,
    { addDefaultGroupsForWaveSubscription: jest.fn() } as never
  );
  const ctx: RequestContext = {
    authenticationContext: AuthenticationContext.fromProfileId('creator'),
    timer: new Timer('native-hub-configuration')
  };
  return { service, ctx, groupIds };
}

async function restoreDisposableSchema() {
  const schema = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
    timezone: 'Etc/UTC',
    entities: Object.values(Entities).filter(
      (entity) => typeof entity === 'function'
    ),
    synchronize: false
  });
  await schema.initialize();
  try {
    await schema.synchronize();
  } finally {
    await schema.destroy();
  }
  await installLegacyCompetitionGetFacade(sqlExecutor);
}

describe('live native shared hub configuration', () => {
  beforeEach(resetTestDatabase);

  it('retains schema-validated CHAT credit, dates and independent private roles', async () => {
    const request = chatRequest();
    const entity = await mapper.createWaveToNewWaveEntity({
      id: 'native-policy-chat',
      serial_no: null,
      created_at: 100,
      updated_at: null,
      request,
      created_by: 'creator',
      descriptionDropId: 'description',
      nextDecisionTime: null,
      isDirectMessage: false
    });
    await repo.executeNativeQueriesInTransaction(async (connection) => {
      await repo.insertWave(entity, { connection });
    });
    const persisted = await repo.findWaveById(entity.id);
    expect(persisted).toMatchObject({
      voting_credit_type: WaveCreditType.TDH_PLUS_XTDH,
      voting_credit_scope: 'DROP',
      voting_group_id: 'voters',
      voting_period_start: request.voting.period!.min,
      participation_group_id: 'participants',
      participation_period_start: request.participation.period!.min,
      participation_terms: request.participation.terms,
      participation_required_metadata: [{ name: 'title', type: 'STRING' }],
      participation_required_media: ['IMAGE'],
      participation_signature_required: true,
      visibility_group_id: 'viewers',
      chat_group_id: 'chatters',
      admin_group_id: 'admins',
      time_lock_ms: null,
      forbid_negative_votes: true
    });
    const archive = await sqlExecutor.oneOrNull<{
      hub_participation_config: string;
      hub_voting_config: string;
    }>(
      `select hub_participation_config,hub_voting_config from ${WAVES_ARCHIVE_TABLE} where id=:id`,
      { id: entity.id }
    );
    expect(JSON.parse(archive!.hub_participation_config)).toMatchObject({
      group_id: 'participants',
      required_metadata: [{ name: 'title', type: 'STRING' }],
      starts_at: request.participation.period!.min,
      terms: request.participation.terms
    });
    expect(JSON.parse(archive!.hub_voting_config)).toMatchObject({
      group_id: 'voters',
      credit_type: 'TDH_PLUS_XTDH',
      starts_at: request.voting.period!.min,
      credit_nfts: []
    });
  });

  it('round trips the ordinary private CHAT UI request through HTTP validation and the real mapper/service', async () => {
    const base = chatRequest();
    const now = Date.now();
    const request = getValidatedByJoiOrThrow(
      {
        ...base,
        voting: {
          ...base.voting,
          scope: { group_id: null },
          credit_scope: ApiWaveCreditScope.Wave,
          forbid_negative_votes: false,
          period: { min: now, max: null }
        },
        participation: {
          ...base.participation,
          scope: { group_id: null },
          no_of_applications_allowed_per_participant: null,
          required_metadata: [],
          required_media: [],
          signature_required: false,
          terms: null,
          period: { min: now, max: null }
        },
        chat: {
          scope: { group_id: 'viewers' },
          enabled: true,
          links_disabled: false
        },
        wave: { ...base.wave, admin_group: { group_id: null } }
      },
      WaveSchema
    );
    const { service, ctx, groupIds } = serviceHarness();
    const created = await service.createWave(request, false, ctx, []);
    expect(created.voting).toMatchObject({
      credit_type: 'TDH_PLUS_XTDH',
      credit_scope: 'WAVE',
      period: request.voting.period,
      scope: { group: null },
      credit_nfts: null
    });
    expect(created.participation).toMatchObject({
      period: request.participation.period,
      scope: { group: null },
      required_media: [],
      required_metadata: [],
      terms: null
    });
    const reread = await service.findWaveByIdOrThrow(created.id, groupIds, ctx);
    expect(reread.voting).toEqual(created.voting);
    expect(reread.participation).toEqual(created.participation);
  });

  it('retains a historical shared-hub NFT list separately from new HTTP request validation', async () => {
    const entity = await mapper.createWaveToNewWaveEntity({
      id: 'historical-chat-credit-nfts',
      serial_no: null,
      created_at: 100,
      updated_at: null,
      request: chatRequest(),
      created_by: 'creator',
      descriptionDropId: 'historical-description',
      nextDecisionTime: null,
      isDirectMessage: false
    });
    // Retained historical configuration is an existing native fixture fact;
    // the current CHAT HTTP schema accepts no CARD_SET_TDH NFT list.
    await repo.executeNativeQueriesInTransaction(async (connection) => {
      await repo.insertWave(
        {
          ...entity,
          voting_credit_nfts: [
            { contract: MEMES_CONTRACT.toLowerCase(), tokenId: 7 }
          ]
        },
        { connection }
      );
    });
    expect(await repo.findWaveVotingCreditNftsByWaveIds([entity.id])).toEqual({
      [entity.id]: [{ contract: MEMES_CONTRACT.toLowerCase(), tokenId: 7 }]
    });
    const archive = await sqlExecutor.oneOrNull<{ hub_voting_config: string }>(
      `select hub_voting_config from ${WAVES_ARCHIVE_TABLE} where id=:id`,
      { id: entity.id }
    );
    expect(JSON.parse(archive!.hub_voting_config).credit_nfts).toEqual([
      { contract: MEMES_CONTRACT.toLowerCase(), token_id: 7 }
    ]);
  });

  it('keeps original competition settings authoritative without replacing the shared hub policy', async () => {
    const request = chatRequest();
    const entity = await mapper.createWaveToNewWaveEntity({
      id: 'original-with-shared-policy',
      serial_no: null,
      created_at: 100,
      updated_at: null,
      request,
      created_by: 'creator',
      descriptionDropId: 'original-description',
      nextDecisionTime: null,
      isDirectMessage: false
    });
    await repo.executeNativeQueriesInTransaction(async (connection) => {
      await repo.insertWave(entity, { connection });
    });
    const sharedBefore = await sqlExecutor.oneOrNull<{
      hub_participation_config: string;
      hub_voting_config: string;
    }>(
      `select hub_participation_config,hub_voting_config from ${WAVES_TABLE} where id=:id`,
      { id: entity.id }
    );
    const originalRequest = {
      ...request,
      name: 'Original competition',
      voting: {
        ...request.voting,
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.Tdh,
        period: { min: null, max: null }
      },
      participation: {
        ...request.participation,
        scope: { group_id: null },
        terms: 'Competition terms',
        period: { min: null, max: null }
      },
      wave: { ...request.wave, type: ApiWaveType.Rank }
    };
    const original = await mapper.createWaveToNewWaveEntity({
      id: entity.id,
      serial_no: 1,
      created_at: 100,
      updated_at: null,
      request: originalRequest,
      created_by: 'creator',
      descriptionDropId: entity.description_drop_id,
      nextDecisionTime: null,
      isDirectMessage: false
    });
    await seedNativeOriginalPrimaryFixture({ ...original, serial_no: 1 });
    const { service, ctx, groupIds } = serviceHarness();
    const updated = await service.updateWave(
      entity.id,
      validateUpdate({ ...originalRequest, name: 'Renamed original' }),
      ctx
    );
    expect(updated.voting.credit_type).toBe(ApiWaveCreditType.Tdh);
    expect(updated.participation.terms).toBe('Competition terms');
    const reread = await service.findWaveByIdOrThrow(entity.id, groupIds, ctx);
    expect(reread.participation.terms).toBe('Competition terms');
    const sharedAfter = await sqlExecutor.oneOrNull(
      `select hub_participation_config,hub_voting_config from ${WAVES_TABLE} where id=:id`,
      { id: entity.id }
    );
    expect(sharedAfter).toEqual(sharedBefore);
    const archive = await sqlExecutor.oneOrNull(
      `select hub_participation_config,hub_voting_config from ${WAVES_ARCHIVE_TABLE} where id=:id order by archive_id desc limit 1`,
      { id: entity.id }
    );
    expect(archive).toEqual(sharedBefore);
  });

  it('creates, edits and reads real CHAT and DM waves and shared chat with retired columns absent', async () => {
    if (
      process.env.NODE_ENV !== 'local' ||
      !process.env.DB_NAME?.includes('_jest_worker_')
    )
      throw new Error('Physical absence requires the disposable Jest database');
    await installLegacyCompetitionGetFacade(sqlExecutor);
    try {
      await sqlExecutor.execute(
        `alter table ${WAVES_TABLE} ${RETIRED_WAVE_COMPETITION_COLUMNS.map((column) => `drop column \`${column}\``).join(',')}`
      );
      await sqlExecutor.execute(
        `alter table ${WAVES_ARCHIVE_TABLE} ${RETIRED_WAVE_COMPETITION_COLUMNS.filter(
          (column) => column !== 'next_decision_time'
        )
          .map((column) => `drop column \`${column}\``)
          .join(',')}`
      );
      await sqlExecutor.execute(`drop table ${WAVE_VOTING_CREDIT_NFTS_TABLE}`);
      const { service, ctx, groupIds } = serviceHarness();
      const request = chatRequest();
      const prepared = await service.prepareWaveCreation(request, ctx);
      const created = await service.createWave(
        request,
        false,
        ctx,
        [],
        prepared
      );
      expect(created.voting).toMatchObject({
        credit_type: 'TDH_PLUS_XTDH',
        credit_scope: 'DROP',
        scope: { group: { id: 'voters' } },
        period: request.voting.period,
        credit_nfts: request.voting.credit_nfts
      });
      expect(created.participation).toMatchObject({
        scope: { group: { id: 'participants' } },
        terms: request.participation.terms,
        required_metadata: request.participation.required_metadata,
        required_media: request.participation.required_media,
        period: request.participation.period
      });
      const restricted = await service.findWaveByIdOrThrow(
        created.id,
        ['viewers', 'chatters'],
        ctx
      );
      expect(restricted.chat.authenticated_user_eligible).toBe(true);
      expect(restricted.voting.authenticated_user_eligible).toBe(false);
      expect(restricted.participation.authenticated_user_eligible).toBe(false);
      await expect(
        service.findWaveByIdOrThrow(created.id, ['chatters'], ctx)
      ).rejects.toThrow('not found');

      const update = {
        ...request,
        name: 'Edited shared chat',
        voting: {
          ...request.voting,
          credit_type: ApiWaveCreditType.Tdh,
          credit_scope: ApiWaveCreditScope.Wave,
          credit_nfts: null,
          scope: { group_id: null },
          period: { min: null, max: null },
          forbid_negative_votes: false
        },
        participation: {
          ...request.participation,
          scope: { group_id: null },
          signature_required: false,
          terms: null,
          period: { min: null, max: null },
          required_metadata: [],
          required_media: [],
          no_of_applications_allowed_per_participant: null
        },
        wave: { ...request.wave, time_lock_ms: null }
      };
      const updated = await service.updateWave(
        created.id,
        validateUpdate(update),
        ctx
      );
      expect(updated.participation).toMatchObject({
        scope: { group: null },
        terms: null,
        period: { min: null, max: null },
        required_metadata: [],
        required_media: []
      });
      expect(updated.voting).toMatchObject({
        credit_type: 'TDH',
        credit_scope: 'WAVE',
        scope: { group: null },
        period: { min: null, max: null },
        credit_nfts: null
      });
      const reread = await service.findWaveByIdOrThrow(
        created.id,
        groupIds,
        ctx
      );
      expect(reread.participation).toEqual(updated.participation);
      expect(reread.voting).toEqual(updated.voting);
      const archives = await sqlExecutor.execute<{
        hub_participation_config: string;
        hub_voting_config: string;
      }>(
        `select hub_participation_config,hub_voting_config from ${WAVES_ARCHIVE_TABLE} where id=:id order by archive_id`,
        { id: created.id }
      );
      expect(archives).toHaveLength(2);
      expect(JSON.parse(archives[0].hub_participation_config).terms).toBe(
        request.participation.terms
      );
      expect(JSON.parse(archives[1].hub_participation_config).terms).toBeNull();
      expect(JSON.parse(archives[1].hub_voting_config).starts_at).toBeNull();

      const dm = await service.findOrCreateDirectMessageWave(
        { id: 'dm-members', name: 'Direct message' } as UserGroupEntity,
        ctx
      );
      expect(dm.participation).toMatchObject({
        scope: { group: { id: 'dm-members' } },
        terms: null,
        period: { min: null, max: null }
      });
      expect(dm.voting).toMatchObject({
        scope: { group: null },
        credit_type: 'TDH'
      });
      expect(
        (
          await service.findOrCreateDirectMessageWave(
            { id: 'dm-members', name: 'Direct message' } as UserGroupEntity,
            ctx
          )
        ).id
      ).toBe(dm.id);
      const editedDm = await service.updateWave(
        dm.id,
        validateUpdate({
          ...update,
          name: 'Renamed direct message',
          visibility: { scope: { group_id: 'dm-members' } },
          chat: { scope: { group_id: 'dm-members' }, enabled: true },
          participation: {
            ...update.participation,
            scope: { group_id: 'dm-members' }
          },
          wave: { ...update.wave, admin_group: { group_id: 'dm-members' } }
        }),
        ctx
      );
      expect(editedDm.name).toBe('Renamed direct message');
      expect(editedDm.participation.scope.group?.id).toBe('dm-members');
      expect(editedDm.voting.scope.group).toBeNull();
      expect(
        (await service.findWaveByIdOrThrow(dm.id, groupIds, ctx)).participation
      ).toEqual(editedDm.participation);
      const chat = new DropsDb(() => sqlExecutor);
      const feed = await chat.findLightDropIdsByWave(
        {
          limit: 10,
          min_serial_no: null,
          max_serial_no: null,
          group_ids_user_is_eligible_for: groupIds,
          wave_id: created.id,
          older_first: true
        },
        ctx
      );
      expect(feed.map((drop) => drop.id)).toEqual([
        created.description_drop.id
      ]);
      expect(await chat.findWaveByIdOrNull(dm.id)).toMatchObject({
        participation_group_id: 'dm-members',
        voting_group_id: null
      });
    } finally {
      await restoreDisposableSchema();
    }
  });
});
