import { DropsMappers } from '@/api/drops/drops.mappers';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { DropEntity, DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { mock } from 'ts-jest-mocker';
import { WaveQuickVoteApiService } from './wave-quick-vote.api.service';
import { WaveQuickVoteDb } from './wave-quick-vote.db';
import { WavesApiDb } from './waves.api.db';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { competitionAnonymityViewerId } from '@/competitions/competition-anonymity';

describe('WaveQuickVoteApiService', () => {
  const wave = {
    ...aWave({ type: WaveType.RANK }, { id: 'wave-1', name: 'Wave' }),
    last_drop_time: 0
  };
  const param = { waveId: wave.id, identityId: 'viewer' };
  const dbParam = { wave_id: wave.id, identity_id: 'viewer' };
  const drop = (id: string): DropEntity => ({
    id,
    serial_no: 1,
    wave_id: wave.id,
    author_id: 'artist',
    created_at: 1,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.PARTICIPATORY,
    signature: null,
    is_additional_action_promised: null
  });
  let db: jest.Mocked<WaveQuickVoteDb>;
  let waves: jest.Mocked<WavesApiDb>;
  let groups: jest.Mocked<UserGroupsService>;
  let mappers: jest.Mocked<DropsMappers>;
  let service: WaveQuickVoteApiService;

  beforeEach(() => {
    db = mock();
    waves = mock();
    groups = mock();
    mappers = mock();
    waves.findWaveById.mockResolvedValue(wave);
    waves.countWaveDecisionsByWaveIds.mockResolvedValue({});
    groups.getGroupsUserIsEligibleFor.mockResolvedValue([]);
    db.countDrops.mockResolvedValue({
      total_count: 6,
      left_to_vote_in_current_round: 3
    });
    db.findDrops.mockResolvedValue([]);
    mappers.convertToDropFulls.mockImplementation(async ({ dropEntities }) =>
      dropEntities.map(({ id }) => ({ id }) as ApiDrop)
    );
    service = new WaveQuickVoteApiService(db, waves, groups, mappers);
  });

  it('keeps the single-drop response and calculates both counts once', async () => {
    db.findDrops.mockResolvedValue([drop('next')]);
    await expect(service.findUndiscoveredDrop(param, {})).resolves.toEqual({
      drop: { id: 'next' },
      total_count: 6,
      left_to_vote_in_current_round: 3
    });
    expect(db.countDrops).toHaveBeenCalledTimes(1);
    expect(db.findDrops).toHaveBeenCalledWith(
      { ...dbParam, skip: 0, limit: 1 },
      false,
      {}
    );
  });

  it('maps a four-drop window together across the skipped boundary', async () => {
    db.findDrops
      .mockResolvedValueOnce([drop('a'), drop('b'), drop('c')])
      .mockResolvedValueOnce([drop('skipped')]);
    await expect(
      service.findUndiscoveredDrops({ ...param, limit: 4 }, {})
    ).resolves.toEqual({
      drops: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'skipped' }],
      total_count: 6,
      left_to_vote_in_current_round: 3
    });
    expect(db.countDrops).toHaveBeenCalledTimes(1);
    expect(db.findDrops).toHaveBeenNthCalledWith(
      1,
      { ...dbParam, skip: 0, limit: 3 },
      false,
      {}
    );
    expect(db.findDrops).toHaveBeenNthCalledWith(
      2,
      { ...dbParam, skip: 0, limit: 1 },
      true,
      {}
    );
    expect(mappers.convertToDropFulls).toHaveBeenCalledTimes(1);
  });

  it.each([
    { viewer: 'owner', action: null, privateOwnerId: 'viewer' },
    {
      viewer: 'voting proxy',
      action: ProfileProxyActionType.RATE_WAVE_DROP,
      privateOwnerId: null
    },
    {
      viewer: 'reading proxy',
      action: ProfileProxyActionType.READ_WAVE,
      privateOwnerId: 'viewer'
    }
  ])(
    'preserves the original $viewer context while hydrating quick vote previews',
    async ({ action, privateOwnerId }) => {
      const authenticationContext = action
        ? new AuthenticationContext({
            authenticatedWallet: null,
            authenticatedProfileId: 'delegate',
            roleProfileId: 'viewer',
            activeProxyActions: [
              {
                id: 'action',
                type: action,
                credit_amount: null,
                credit_spent: null
              }
            ]
          })
        : AuthenticationContext.fromProfileId('viewer');
      const connection = { connection: {} };
      const ctx = { authenticationContext, connection };
      const previews = ['a', 'b', 'c', 'd'].map(drop);
      db.countDrops.mockResolvedValue({
        total_count: 4,
        left_to_vote_in_current_round: 4
      });
      db.findDrops.mockResolvedValue(previews);

      const result = await service.findUndiscoveredDrops(
        { ...param, limit: 4 },
        ctx
      );

      expect(result.drops.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd']);
      expect(mappers.convertToDropFulls).toHaveBeenCalledTimes(1);
      expect(mappers.convertToDropFulls).toHaveBeenCalledWith(
        {
          dropEntities: previews,
          contextProfileId: 'viewer',
          authenticationContext
        },
        connection
      );
      const forwarded =
        mappers.convertToDropFulls.mock.calls[0][0].authenticationContext;
      expect(forwarded).toBe(authenticationContext);
      expect(
        competitionAnonymityViewerId({ authenticationContext: forwarded })
      ).toBe(privateOwnerId);
      expect(forwarded?.hasRightsTo(ProfileProxyActionType.READ_WAVE)).toBe(
        privateOwnerId !== null
      );
    }
  );

  it('fills the window when concurrent votes shorten the unskipped tail', async () => {
    db.findDrops
      .mockResolvedValueOnce([drop('still-unskipped')])
      .mockResolvedValueOnce([drop('skip-a'), drop('skip-b'), drop('skip-c')]);
    const result = await service.findUndiscoveredDrops(
      { ...param, limit: 4 },
      {}
    );
    expect(result.drops.map(({ id }) => id)).toEqual([
      'still-unskipped',
      'skip-a',
      'skip-b',
      'skip-c'
    ]);
    expect(db.findDrops).toHaveBeenNthCalledWith(
      2,
      { ...dbParam, skip: 0, limit: 3 },
      true,
      {}
    );
  });

  it('does not fetch skipped drops when the window fits in undiscovered drops', async () => {
    db.findDrops.mockResolvedValue(['a', 'b', 'c', 'd'].map(drop));
    db.countDrops.mockResolvedValue({
      total_count: 6,
      left_to_vote_in_current_round: 6
    });
    await service.findUndiscoveredDrops({ ...param, limit: 4 }, {});
    expect(db.findDrops).toHaveBeenCalledTimes(1);
    expect(db.findDrops).toHaveBeenCalledWith(
      { ...dbParam, skip: 0, limit: 4 },
      false,
      {}
    );
  });

  it('keeps single-drop offsets within the unskipped portion', async () => {
    await service.findUndiscoveredDrop({ ...param, skip: 2 }, {});
    expect(db.findDrops).toHaveBeenCalledWith(
      { ...dbParam, skip: 2, limit: 1 },
      false,
      {}
    );
  });

  it('continues single-drop offsets into skipped drops', async () => {
    await service.findUndiscoveredDrop({ ...param, skip: 4 }, {});
    expect(db.findDrops).toHaveBeenCalledWith(
      { ...dbParam, skip: 1, limit: 1 },
      true,
      {}
    );
  });

  it('starts with the earliest skipped drops when no undiscovered drops remain', async () => {
    db.countDrops.mockResolvedValue({
      total_count: 6,
      left_to_vote_in_current_round: 0
    });
    await service.findUndiscoveredDrops({ ...param, limit: 4 }, {});
    expect(db.findDrops).toHaveBeenCalledTimes(1);
    expect(db.findDrops).toHaveBeenCalledWith(
      { ...dbParam, skip: 0, limit: 4 },
      true,
      {}
    );
  });

  it('returns null and zero counts for an exhausted single-drop request', async () => {
    db.countDrops.mockResolvedValue({
      total_count: 0,
      left_to_vote_in_current_round: 0
    });
    await expect(service.findUndiscoveredDrop(param, {})).resolves.toEqual({
      drop: null,
      total_count: 0,
      left_to_vote_in_current_round: 0
    });
    expect(mappers.convertToDropFulls).not.toHaveBeenCalled();
  });

  it('checks restricted parents before reading quick-vote data', async () => {
    waves.findWaveById
      .mockResolvedValueOnce({ ...wave, parent_wave_id: 'parent' })
      .mockResolvedValueOnce({
        ...wave,
        id: 'parent',
        visibility_group_id: 'restricted'
      });
    await expect(
      service.findUndiscoveredDrops({ ...param, limit: 4 }, {})
    ).rejects.toThrow(`Wave ${wave.id} not found`);
    expect(db.countDrops).not.toHaveBeenCalled();
  });

  it('rejects ineligible voters', async () => {
    waves.findWaveById.mockResolvedValue({
      ...wave,
      voting_group_id: 'voters'
    });
    await expect(service.findUndiscoveredDrop(param, {})).rejects.toThrow(
      'Voter is not eligible'
    );
    expect(db.countDrops).not.toHaveBeenCalled();
  });

  it('rejects chat waves', async () => {
    waves.findWaveById.mockResolvedValue({ ...wave, type: WaveType.CHAT });
    await expect(service.findUndiscoveredDrop(param, {})).rejects.toThrow(
      'Voting is not allowed'
    );
  });

  it('rejects closed approve waves', async () => {
    waves.findWaveById.mockResolvedValue({
      ...wave,
      type: WaveType.APPROVE,
      max_winners: 1
    });
    waves.countWaveDecisionsByWaveIds.mockResolvedValue({ [wave.id]: 1 });
    await expect(service.findUndiscoveredDrop(param, {})).rejects.toThrow(
      'Voting is closed'
    );
  });
});
