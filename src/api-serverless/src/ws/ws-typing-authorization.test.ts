import 'reflect-metadata';
import { WsListenersNotifier } from './ws-listeners-notifier';
import { WsConnectionRepository } from './ws-connection.repository';
import { ANON_USER_ID, AppWebSockets } from './ws';
import { UserGroupsService } from '../community-members/user-groups.service';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { SqlExecutor } from '@/sql-executor';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { ApiGroupFull } from '../generated/models/ApiGroupFull';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiGroupTdhInclusionStrategy } from '../generated/models/ApiGroupTdhInclusionStrategy';
import { ApiGroupBeneficiaryGrantMatchMode } from '../generated/models/ApiGroupBeneficiaryGrantMatchMode';
import { identitiesDb } from '@/identities/identities.db';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { IdentityEntity } from '@/entities/IIdentity';
import { NotFoundException, UnauthorisedException } from '@/exceptions';
import { Logger } from '@/logging';
import { mock } from 'ts-jest-mocker';

type Row = { connection_id: string; profile_id: string; wave_id: string };
const row = (profile: string, wave = 'wave'): Row => ({
  connection_id: `${profile}-${wave}`,
  profile_id: profile,
  wave_id: wave
});

function fixture(
  options: { privateChild?: boolean; privateParent?: boolean } = {}
) {
  const groups = [
    {
      id: 'child',
      is_private: options.privateChild ?? false,
      created_by: 'owner'
    },
    {
      id: 'parent',
      is_private: options.privateParent ?? false,
      created_by: 'owner'
    }
  ];
  const groupRows: Record<string, Row[]> = {
    child: [
      row('sender'),
      row('both'),
      row('child-only'),
      row('both', 'other')
    ],
    parent: [
      row('sender'),
      row('both'),
      row('parent-only'),
      row('both', 'other')
    ]
  };
  const execute = jest.fn(
    async (sql: string, params: Record<string, unknown>) => {
      if (sql.includes('where id = :id')) {
        const group = groups.find((it) => it.id === params.id);
        const eligible = params.eligibleGroupIds as string[];
        // Fake only SQL I/O; the real visibility helper chooses the caller/binds.
        return group &&
          (!group.is_private ||
            group.created_by === params.authenticatedUserId ||
            eligible.includes(group.id))
          ? [group]
          : [];
      }
      if (sql.includes('join user_groups_view')) {
        return groupRows[String(params.profile_group_id)];
      }
      if (sql.includes('where ws.wave_id = :waveId')) {
        return [row('sender'), row('both'), row(ANON_USER_ID)];
      }
      throw new Error('Unexpected SQL in synthetic fixture');
    }
  );
  const oneOrNull = jest.fn().mockResolvedValue({
    visibility_group_id: 'child',
    parent_wave_id: 'parent-wave',
    parent_id: 'parent-wave',
    parent_parent_id: null,
    parent_group_id: 'parent'
  });
  const db = { execute, oneOrNull } as unknown as SqlExecutor;
  const service = new UserGroupsService(
    new UserGroupsDb(() => db),
    mock(),
    mock()
  );
  jest
    .spyOn(service, 'getGroupsUserIsEligibleFor')
    .mockImplementation(async (profile) =>
      profile === 'sender' ? ['child', 'parent'] : []
    );
  // Presentation/enrichment is outside the real access + membership builder under test.
  jest
    .spyOn(
      service as unknown as {
        mapForApi(groups: UserGroupEntity[]): Promise<ApiGroupFull[]>;
      },
      'mapForApi'
    )
    .mockImplementation(async (entities) =>
      entities.map(
        (group) =>
          ({
            id: group.id,
            name: 'synthetic group',
            created_at: 0,
            created_by: mock<ApiProfileMin>(),
            visible: true,
            is_private: group.is_private,
            group: {
              cic: {
                min: null,
                max: null,
                user_identity: null,
                direction: null
              },
              rep: {
                min: null,
                max: null,
                user_identity: null,
                direction: null,
                category: null
              },
              level: { min: null, max: null },
              tdh: {
                min: null,
                max: null,
                inclusion_strategy: ApiGroupTdhInclusionStrategy.Tdh
              },
              owns_nfts: [],
              identity_group_id: group.id,
              identity_group_identities_count: 3,
              excluded_identity_group_id: null,
              excluded_identity_group_identities_count: 0,
              is_beneficiary_of_grant_id: null,
              is_beneficiary_of_grant: null,
              is_beneficiary_of_grant_match_mode:
                ApiGroupBeneficiaryGrantMatchMode.AnyToken
            }
          }) satisfies ApiGroupFull
      )
    );
  const repository = new WsConnectionRepository(
    () => db,
    service,
    () => false
  );
  const send = jest.fn().mockResolvedValue(undefined);
  const notifier = new WsListenersNotifier(
    { send } as unknown as AppWebSockets,
    repository
  );
  return { notifier, repository, service, send, execute, oneOrNull, groupRows };
}

describe('typing sender and recipient authorization', () => {
  beforeEach(() => {
    jest
      .spyOn(identitiesDb, 'getIdentityByProfileId')
      .mockImplementation(async (profile) =>
        profile === 'deleted'
          ? null
          : ({
              profile_id: profile,
              handle: 'synthetic',
              level_raw: 0
            } as IdentityEntity)
      );
    jest.spyOn(identitiesDb, 'getActiveMainStageDropIds').mockResolvedValue({});
    jest.spyOn(identitiesDb, 'getMainStageWinnerDropIds').mockResolvedValue({});
    jest.spyOn(identitiesDb, 'getArtistOfPrevoteCards').mockResolvedValue({});
    jest
      .spyOn(identitiesDb, 'getWaveCreatorProfileIds')
      .mockResolvedValue(new Set());
    jest
      .spyOn(profileWavesDb, 'findProfileWaveIdsByProfileIds')
      .mockResolvedValue({});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { privateChild: true },
    { privateParent: true },
    { privateChild: true, privateParent: true },
    {}
  ])(
    'uses real visibility helpers and preserves the child/parent intersection: %p',
    async (options) => {
      const f = fixture(options);
      await f.notifier.notifyAboutUserIsTyping({
        identityId: 'sender',
        waveId: 'wave'
      });
      expect(f.service.getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
        'sender',
        undefined
      );
      expect(f.send.mock.calls.map(([input]) => input.connectionId)).toEqual([
        'sender-wave',
        'both-wave'
      ]);
      expect(JSON.parse(f.send.mock.calls[0][0].message).data.profile.id).toBe(
        'sender'
      );
    }
  );

  it('reproduces the previous anonymous context failure with the real helpers', async () => {
    const f = fixture({ privateChild: true });
    await expect(
      f.repository.getCurrentlyOnlineCommunityMemberConnectionIds(
        { waveId: 'wave', groupId: null },
        {}
      )
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('keeps authenticated typing on an ungrouped wave and its anonymous recipients', async () => {
    const f = fixture();
    f.oneOrNull.mockResolvedValue({
      visibility_group_id: null,
      parent_wave_id: null,
      parent_id: null,
      parent_parent_id: null,
      parent_group_id: null
    });
    await f.notifier.notifyAboutUserIsTyping({
      identityId: 'sender',
      waveId: 'wave'
    });
    expect(f.send.mock.calls.map(([input]) => input.connectionId)).toEqual([
      'sender-wave',
      'both-wave',
      `${ANON_USER_ID}-wave`
    ]);
  });

  it.each(['outsider', 'owner'])(
    'does not confuse group visibility with sender eligibility: %s',
    async (identityId) => {
      const f = fixture({ privateChild: true, privateParent: true });
      await expect(
        f.notifier.notifyAboutUserIsTyping({ identityId, waveId: 'wave' })
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(f.send).not.toHaveBeenCalled();
    }
  );

  it.each(['child', 'parent'])(
    'fails closed when current %s membership has been removed despite cached eligibility',
    async (group) => {
      const f = fixture({ privateChild: true, privateParent: true });
      f.groupRows[group] = f.groupRows[group].filter(
        (it) => it.profile_id !== 'sender'
      );
      await expect(
        f.notifier.notifyAboutUserIsTyping({
          identityId: 'sender',
          waveId: 'wave'
        })
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(f.send).not.toHaveBeenCalled();
    }
  );

  it.each([ANON_USER_ID, 'deleted'])(
    'rejects anonymous or stale identities before recipient lookup: %s',
    async (identityId) => {
      const f = fixture();
      await expect(
        f.notifier.notifyAboutUserIsTyping({ identityId, waveId: 'wave' })
      ).rejects.toBeInstanceOf(UnauthorisedException);
      expect(f.oneOrNull).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    { parent_wave_id: 'missing', parent_id: null },
    {
      parent_wave_id: 'parent',
      parent_id: 'parent',
      parent_parent_id: 'grandparent'
    }
  ])('rejects a missing or invalid parent chain: %p', async (wave) => {
    const f = fixture();
    f.oneOrNull.mockResolvedValue(wave);
    await expect(
      f.notifier.notifyAboutUserIsTyping({
        identityId: 'sender',
        waveId: 'wave'
      })
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('records only bounded stage/error labels and preserves an unexpected failure', async () => {
    const f = fixture();
    const log = jest
      .spyOn(Logger.get('WsListenersNotifier'), 'error')
      .mockImplementation(() => undefined);
    const error = Object.assign(new Error('private SQL/body/identity'), {
      code: 'ER_NO_SUCH_TABLE'
    });
    f.oneOrNull.mockRejectedValue(error);
    await expect(
      f.notifier.notifyAboutUserIsTyping({
        identityId: 'sender',
        waveId: 'wave'
      })
    ).rejects.toBe(error);
    expect(log).toHaveBeenCalledWith({
      code: 'WS_TYPING_FAILED',
      stage: 'recipients',
      error_type: 'Error',
      error_code: 'ER_NO_SUCH_TABLE'
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it('preserves the original error if diagnostic logging fails', async () => {
    const f = fixture();
    jest
      .spyOn(Logger.get('WsListenersNotifier'), 'error')
      .mockImplementation(() => {
        throw new Error('logger failed');
      });
    const error = new Error('original');
    f.oneOrNull.mockRejectedValue(error);
    await expect(
      f.notifier.notifyAboutUserIsTyping({
        identityId: 'sender',
        waveId: 'wave'
      })
    ).rejects.toBe(error);
  });
});
