import { AuthenticationContext } from '@/auth-context';
import {
  DropBoostEntity,
  DropEntity,
  DropMediaEntity,
  DropMetadataEntity,
  DropPartEntity,
  DropType
} from '@/entities/IDrop';
import { WaveCreditType, WaveEntity, WaveType } from '@/entities/IWave';
import { NotFoundException } from '@/exceptions';
import { ApiDropV2Service } from './api-drop-v2.service';
import {
  AttachmentEntity,
  AttachmentKind,
  AttachmentStatus,
  DropAttachmentEntity
} from '@/entities/IAttachment';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '@/entities/IProfileActivityLog';
import { PageSortDirection } from '@/api/page-request';

function makeDrop(overrides: Partial<DropEntity> = {}): DropEntity {
  return {
    serial_no: 1,
    id: 'drop-1',
    wave_id: 'wave-1',
    author_id: 'author-1',
    created_at: 100,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    hide_link_preview: false,
    ...overrides
  };
}

function makeWave(overrides: Partial<WaveEntity> = {}): WaveEntity {
  return {
    id: 'wave-1',
    serial_no: 1,
    name: 'Wave 1',
    picture: null,
    description_drop_id: 'description-drop-1',
    created_at: 100,
    updated_at: null,
    created_by: 'creator-1',
    voting_group_id: null,
    admin_group_id: null,
    voting_credit_type: WaveCreditType.TDH,
    voting_credit_category: null,
    voting_credit_creditor: null,
    voting_signature_required: false,
    voting_period_start: null,
    voting_period_end: null,
    visibility_group_id: null,
    participation_group_id: null,
    chat_enabled: true,
    chat_group_id: null,
    participation_max_applications_per_participant: null,
    participation_required_metadata: [],
    participation_required_media: [],
    submission_type: null,
    identity_submission_strategy: null,
    identity_submission_duplicates: null,
    participation_period_start: null,
    participation_period_end: null,
    participation_signature_required: false,
    participation_terms: null,
    type: WaveType.CHAT,
    winning_min_threshold: null,
    winning_max_threshold: null,
    max_winners: null,
    max_votes_per_identity_to_drop: null,
    time_lock_ms: null,
    decisions_strategy: null,
    next_decision_time: null,
    forbid_negative_votes: false,
    admin_drop_deletion_enabled: false,
    is_direct_message: false,
    ...overrides
  };
}

function makeMetadata(
  overrides: Partial<DropMetadataEntity> = {}
): DropMetadataEntity {
  return {
    id: '1',
    drop_id: 'drop-1',
    data_key: 'season',
    data_value: '1',
    wave_id: 'wave-1',
    ...overrides
  };
}

function makePart(overrides: Partial<DropPartEntity> = {}): DropPartEntity {
  return {
    drop_id: 'drop-1',
    drop_part_id: 1,
    content: 'Part content',
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: 'wave-1',
    ...overrides
  };
}

function makeMedia(overrides: Partial<DropMediaEntity> = {}): DropMediaEntity {
  return {
    id: 'media-1',
    drop_id: 'drop-1',
    drop_part_id: 1,
    url: 'https://example.com/image.png',
    mime_type: 'image/png',
    wave_id: 'wave-1',
    ...overrides
  };
}

function makeDropAttachment(
  overrides: Partial<DropAttachmentEntity> = {}
): DropAttachmentEntity {
  return {
    drop_id: 'drop-1',
    drop_part_id: 1,
    attachment_id: 'attachment-1',
    wave_id: 'wave-1',
    ...overrides
  };
}

function makeAttachment(
  overrides: Partial<AttachmentEntity> = {}
): AttachmentEntity {
  return {
    id: 'attachment-1',
    owner_profile_id: 'author-1',
    original_file_name: 'file.pdf',
    kind: AttachmentKind.PDF,
    declared_mime: 'application/pdf',
    detected_mime: null,
    status: AttachmentStatus.READY,
    original_bucket: null,
    original_key: null,
    size_bytes: null,
    sha256: null,
    guardduty_status: null,
    verdict: null,
    ipfs_cid: null,
    ipfs_url: 'https://example.com/file.pdf',
    error_reason: null,
    created_at: 100,
    updated_at: 100,
    ...overrides
  };
}

function makeBoost(overrides: Partial<DropBoostEntity> = {}): DropBoostEntity {
  return {
    drop_id: 'drop-1',
    booster_id: 'booster-1',
    boosted_at: 200,
    wave_id: 'wave-1',
    ...overrides
  };
}

function makeVoteEditLog(
  overrides: Partial<ProfileActivityLog> = {}
): ProfileActivityLog {
  return {
    id: 'log-1',
    profile_id: 'voter-1',
    target_id: 'drop-1',
    proxy_id: null,
    contents: JSON.stringify({
      oldVote: 1,
      newVote: 2
    }),
    type: ProfileActivityLogType.DROP_VOTE_EDIT,
    additional_data_1: 'author-1',
    additional_data_2: 'wave-1',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

function createService() {
  const dropsDb = {
    findDropByIdWithEligibilityCheck: jest.fn().mockResolvedValue(makeDrop()),
    findWaveByIdOrNull: jest.fn().mockResolvedValue(makeWave()),
    findMetadataByDropId: jest.fn().mockResolvedValue([]),
    findDropPartByDropIdAndPartNo: jest.fn().mockResolvedValue(makePart()),
    findDropPartMedia: jest.fn().mockResolvedValue([]),
    findDropBoostsByDropId: jest.fn().mockResolvedValue([]),
    findDropVoteEditLogEntities: jest.fn().mockResolvedValue([]),
    findDropVotersByAbsoluteVote: jest.fn().mockResolvedValue([]),
    countDropVotersByAbsoluteVote: jest.fn().mockResolvedValue(0),
    getWinnerDropVoters: jest.fn().mockResolvedValue([]),
    countWinnerDropVoters: jest.fn().mockResolvedValue(0)
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['group-1'])
  };
  const apiDropMapper = {
    mapDrops: jest.fn().mockResolvedValue({
      'drop-1': { id: 'drop-1' }
    })
  };
  const apiWaveOverviewMapper = {
    mapWaves: jest.fn().mockResolvedValue({
      'wave-1': { id: 'wave-1' }
    })
  };
  const identityFetcher = {
    getDropResolvedIdentityProfilesV2ByIds: jest.fn().mockResolvedValue({}),
    getApiIdentityOverviewsByIds: jest.fn().mockResolvedValue({})
  };
  const attachmentsDb = {
    getDropPartAttachments: jest.fn().mockResolvedValue([]),
    findAttachmentsByIds: jest.fn().mockResolvedValue({})
  };
  const reactionsDb = {
    getReactionProfilesByDropId: jest.fn().mockResolvedValue([])
  };

  return {
    service: new ApiDropV2Service(
      dropsDb as any,
      userGroupsService as any,
      apiDropMapper as any,
      apiWaveOverviewMapper as any,
      identityFetcher as any,
      attachmentsDb as any,
      reactionsDb as any
    ),
    deps: {
      dropsDb,
      userGroupsService,
      apiDropMapper,
      apiWaveOverviewMapper,
      identityFetcher,
      attachmentsDb,
      reactionsDb
    }
  };
}

describe('ApiDropV2Service', () => {
  it('finds visible drop and maps it with wave overview', async () => {
    const { service, deps } = createService();
    const drop = makeDrop();
    const wave = makeWave();
    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const connection = {} as any;
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(drop);
    deps.dropsDb.findWaveByIdOrNull.mockResolvedValue(wave);

    const result = await service.findWithWaveByIdOrThrow('drop-1', {
      authenticationContext,
      connection
    });

    expect(result).toEqual({
      drop: { id: 'drop-1' },
      wave: { id: 'wave-1' }
    });
    expect(
      deps.userGroupsService.getGroupsUserIsEligibleFor
    ).toHaveBeenCalledWith('viewer-1', undefined);
    expect(deps.dropsDb.findDropByIdWithEligibilityCheck).toHaveBeenCalledWith(
      'drop-1',
      ['group-1'],
      connection
    );
    expect(deps.dropsDb.findWaveByIdOrNull).toHaveBeenCalledWith(
      'wave-1',
      connection
    );
    expect(deps.apiDropMapper.mapDrops).toHaveBeenCalledWith([drop], {
      authenticationContext,
      connection
    });
    expect(deps.apiWaveOverviewMapper.mapWaves).toHaveBeenCalledWith([wave], {
      authenticationContext,
      connection
    });
  });

  it('throws when drop is missing or not visible', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(null);

    await expect(
      service.findWithWaveByIdOrThrow('missing-drop', {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).rejects.toThrow(NotFoundException);

    expect(
      deps.userGroupsService.getGroupsUserIsEligibleFor
    ).toHaveBeenCalledWith(null, undefined);
    expect(deps.dropsDb.findWaveByIdOrNull).not.toHaveBeenCalled();
    expect(deps.apiDropMapper.mapDrops).not.toHaveBeenCalled();
    expect(deps.apiWaveOverviewMapper.mapWaves).not.toHaveBeenCalled();
  });

  it('throws when owning wave is missing', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findWaveByIdOrNull.mockResolvedValue(null);

    await expect(
      service.findWithWaveByIdOrThrow('drop-1', {
        authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
      })
    ).rejects.toThrow(NotFoundException);

    expect(deps.apiDropMapper.mapDrops).toHaveBeenCalled();
    expect(deps.apiWaveOverviewMapper.mapWaves).not.toHaveBeenCalled();
  });

  it('finds visible drop metadata and resolves identity metadata to V2 profile', async () => {
    const { service, deps } = createService();
    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const connection = {} as any;
    const resolvedProfile = {
      id: 'profile-1',
      primary_address: '0x1',
      handle: 'alice',
      pfp: 'pfp.png',
      level: 3,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 1,
        artist_of_memes: 2
      },
      bio: 'Bio',
      top_rep_categories: [{ category: 'Cool', rep: 10 }]
    };
    deps.dropsDb.findMetadataByDropId.mockResolvedValue([
      makeMetadata({ id: '1', data_key: 'season', data_value: '1' }),
      makeMetadata({ id: '2', data_key: 'identity', data_value: 'profile-1' })
    ]);
    deps.identityFetcher.getDropResolvedIdentityProfilesV2ByIds.mockResolvedValue(
      {
        'profile-1': resolvedProfile
      }
    );

    const result = await service.findMetadataByDropIdOrThrow('drop-1', {
      authenticationContext,
      connection
    });

    expect(result).toEqual([
      {
        data_key: 'season',
        data_value: '1'
      },
      {
        data_key: 'identity',
        data_value: 'profile-1',
        resolved_profile: resolvedProfile
      }
    ]);
    expect(
      deps.userGroupsService.getGroupsUserIsEligibleFor
    ).toHaveBeenCalledWith('viewer-1', undefined);
    expect(deps.dropsDb.findDropByIdWithEligibilityCheck).toHaveBeenCalledWith(
      'drop-1',
      ['group-1'],
      connection
    );
    expect(deps.dropsDb.findMetadataByDropId).toHaveBeenCalledWith('drop-1', {
      authenticationContext,
      connection
    });
    expect(
      deps.identityFetcher.getDropResolvedIdentityProfilesV2ByIds
    ).toHaveBeenCalledWith(
      {
        ids: ['profile-1']
      },
      {
        authenticationContext,
        connection
      }
    );
  });

  it('throws for hidden metadata drops without fetching metadata', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(null);

    await expect(
      service.findMetadataByDropIdOrThrow('missing-drop', {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).rejects.toThrow(NotFoundException);

    expect(deps.dropsDb.findMetadataByDropId).not.toHaveBeenCalled();
    expect(
      deps.identityFetcher.getDropResolvedIdentityProfilesV2ByIds
    ).not.toHaveBeenCalled();
  });

  it('returns empty metadata without resolving identities', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findMetadataByDropId.mockResolvedValue([]);

    const result = await service.findMetadataByDropIdOrThrow('drop-1', {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    });

    expect(result).toEqual([]);
    expect(deps.dropsDb.findMetadataByDropId).toHaveBeenCalled();
    expect(
      deps.identityFetcher.getDropResolvedIdentityProfilesV2ByIds
    ).not.toHaveBeenCalled();
  });

  it('finds visible drop part and maps only that part', async () => {
    const { service, deps } = createService();
    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const connection = {} as any;
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(
      makeDrop({ parts_count: 2 })
    );
    deps.dropsDb.findDropPartByDropIdAndPartNo.mockResolvedValue(
      makePart({
        drop_part_id: 2,
        content: 'Second part',
        quoted_drop_id: 'quoted-drop',
        quoted_drop_part_id: 1
      })
    );
    deps.dropsDb.findDropPartMedia.mockResolvedValue([
      makeMedia({ id: 'media-2', drop_part_id: 2 })
    ]);
    deps.attachmentsDb.getDropPartAttachments.mockResolvedValue([
      makeDropAttachment({ drop_part_id: 2 })
    ]);
    deps.attachmentsDb.findAttachmentsByIds.mockResolvedValue({
      'attachment-1': makeAttachment()
    });

    const result = await service.findPartByDropIdOrThrow('drop-1', 2, {
      authenticationContext,
      connection
    });

    expect(result).toEqual({
      part_no: 2,
      content: 'Second part',
      media: [
        {
          url: 'https://example.com/image.png',
          mime_type: 'image/png'
        }
      ],
      attachments: [
        {
          attachment_id: 'attachment-1',
          file_name: 'file.pdf',
          mime_type: 'application/pdf',
          kind: 'pdf',
          status: 'ready',
          url: 'https://example.com/file.pdf'
        }
      ],
      quoted_drop: {
        drop_id: 'quoted-drop',
        drop_part_id: 1
      }
    });
    expect(deps.dropsDb.findDropByIdWithEligibilityCheck).toHaveBeenCalledWith(
      'drop-1',
      ['group-1'],
      connection
    );
    expect(deps.dropsDb.findDropPartByDropIdAndPartNo).toHaveBeenCalledWith(
      'drop-1',
      2,
      {
        authenticationContext,
        connection
      }
    );
    expect(deps.dropsDb.findDropPartMedia).toHaveBeenCalledWith('drop-1', 2, {
      authenticationContext,
      connection
    });
    expect(deps.attachmentsDb.getDropPartAttachments).toHaveBeenCalledWith(
      'drop-1',
      2,
      {
        authenticationContext,
        connection
      }
    );
    expect(deps.attachmentsDb.findAttachmentsByIds).toHaveBeenCalledWith(
      ['attachment-1'],
      connection
    );
  });

  it('throws for hidden drop part without fetching the part', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(null);

    await expect(
      service.findPartByDropIdOrThrow('missing-drop', 1, {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).rejects.toThrow(NotFoundException);

    expect(deps.dropsDb.findDropPartByDropIdAndPartNo).not.toHaveBeenCalled();
    expect(deps.dropsDb.findDropPartMedia).not.toHaveBeenCalled();
    expect(deps.attachmentsDb.getDropPartAttachments).not.toHaveBeenCalled();
  });

  it('throws when requested part is outside the drop part count', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(
      makeDrop({ parts_count: 1 })
    );

    await expect(
      service.findPartByDropIdOrThrow('drop-1', 2, {
        authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
      })
    ).rejects.toThrow(NotFoundException);

    expect(deps.dropsDb.findDropPartByDropIdAndPartNo).not.toHaveBeenCalled();
    expect(deps.dropsDb.findDropPartMedia).not.toHaveBeenCalled();
    expect(deps.attachmentsDb.getDropPartAttachments).not.toHaveBeenCalled();
  });

  it('finds visible drop boosts and maps boosters to identity overviews', async () => {
    const { service, deps } = createService();
    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const connection = {} as any;
    const boosterOne = {
      id: 'booster-1',
      primary_address: '0x1',
      handle: 'alice',
      level: 4,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 0,
        artist_of_memes: 1
      }
    };
    const boosterTwo = {
      id: 'booster-2',
      primary_address: '0x2',
      level: 2,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 1,
        artist_of_memes: 0
      }
    };
    deps.dropsDb.findDropBoostsByDropId.mockResolvedValue([
      makeBoost({
        booster_id: 'booster-1',
        boosted_at: 300
      }),
      makeBoost({
        booster_id: 'booster-2',
        boosted_at: 200
      })
    ]);
    deps.identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'booster-1': boosterOne,
      'booster-2': boosterTwo
    });

    const result = await service.findBoostsByDropIdOrThrow('drop-1', {
      authenticationContext,
      connection
    });

    expect(result).toEqual([
      {
        booster: boosterOne,
        boosted_at: 300
      },
      {
        booster: boosterTwo,
        boosted_at: 200
      }
    ]);
    expect(deps.dropsDb.findDropByIdWithEligibilityCheck).toHaveBeenCalledWith(
      'drop-1',
      ['group-1'],
      connection
    );
    expect(deps.dropsDb.findDropBoostsByDropId).toHaveBeenCalledWith('drop-1', {
      authenticationContext,
      connection
    });
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).toHaveBeenCalledWith(['booster-1', 'booster-2'], {
      authenticationContext,
      connection
    });
  });

  it('throws for hidden boost drops without fetching boosts', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(null);

    await expect(
      service.findBoostsByDropIdOrThrow('missing-drop', {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).rejects.toThrow(NotFoundException);

    expect(deps.dropsDb.findDropBoostsByDropId).not.toHaveBeenCalled();
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).not.toHaveBeenCalled();
  });

  it('returns empty boosts without resolving booster identities', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropBoostsByDropId.mockResolvedValue([]);

    const result = await service.findBoostsByDropIdOrThrow('drop-1', {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    });

    expect(result).toEqual([]);
    expect(deps.dropsDb.findDropBoostsByDropId).toHaveBeenCalled();
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).not.toHaveBeenCalled();
  });

  it('finds visible drop reactions and maps reactors to identity overviews', async () => {
    const { service, deps } = createService();
    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const connection = {} as any;
    const reactorOne = {
      id: 'reactor-1',
      primary_address: '0x1',
      handle: 'alice',
      level: 4,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 0,
        artist_of_memes: 1
      }
    };
    const reactorTwo = {
      id: 'reactor-2',
      primary_address: '0x2',
      level: 2,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 1,
        artist_of_memes: 0
      }
    };
    deps.reactionsDb.getReactionProfilesByDropId.mockResolvedValue([
      {
        reaction: ':+1:',
        profile_id: 'reactor-1'
      },
      {
        reaction: ':fire:',
        profile_id: 'reactor-2'
      },
      {
        reaction: ':+1:',
        profile_id: 'reactor-2'
      }
    ]);
    deps.identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'reactor-1': reactorOne,
      'reactor-2': reactorTwo
    });

    const result = await service.findReactionsByDropIdOrThrow('drop-1', {
      authenticationContext,
      connection
    });

    expect(result).toEqual([
      {
        reaction: ':+1:',
        reactors: [reactorOne, reactorTwo]
      },
      {
        reaction: ':fire:',
        reactors: [reactorTwo]
      }
    ]);
    expect(deps.dropsDb.findDropByIdWithEligibilityCheck).toHaveBeenCalledWith(
      'drop-1',
      ['group-1'],
      connection
    );
    expect(deps.reactionsDb.getReactionProfilesByDropId).toHaveBeenCalledWith(
      'drop-1',
      {
        authenticationContext,
        connection
      }
    );
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).toHaveBeenCalledWith(['reactor-1', 'reactor-2'], {
      authenticationContext,
      connection
    });
  });

  it('throws for hidden reaction drops without fetching reactions', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(null);

    await expect(
      service.findReactionsByDropIdOrThrow('missing-drop', {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).rejects.toThrow(NotFoundException);

    expect(deps.reactionsDb.getReactionProfilesByDropId).not.toHaveBeenCalled();
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).not.toHaveBeenCalled();
  });

  it('returns empty reactions without resolving reactor identities', async () => {
    const { service, deps } = createService();
    deps.reactionsDb.getReactionProfilesByDropId.mockResolvedValue([]);

    const result = await service.findReactionsByDropIdOrThrow('drop-1', {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    });

    expect(result).toEqual([]);
    expect(deps.reactionsDb.getReactionProfilesByDropId).toHaveBeenCalled();
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).not.toHaveBeenCalled();
  });

  it('finds visible drop vote edit logs and maps voters to identity overviews', async () => {
    const { service, deps } = createService();
    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const connection = {} as any;
    const voterOne = {
      id: 'voter-1',
      primary_address: '0x1',
      handle: 'alice',
      level: 4,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 0,
        artist_of_memes: 1
      }
    };
    const voterTwo = {
      id: 'voter-2',
      primary_address: '0x2',
      level: 2,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 1,
        artist_of_memes: 0
      }
    };
    deps.dropsDb.findDropVoteEditLogEntities.mockResolvedValue([
      makeVoteEditLog({
        id: 'log-1',
        profile_id: 'voter-1',
        contents: JSON.stringify({
          oldVote: 5,
          newVote: 10
        }),
        created_at: new Date('2026-01-01T00:00:00.000Z')
      }),
      makeVoteEditLog({
        id: 'log-2',
        profile_id: 'voter-2',
        contents: JSON.stringify({
          newVote: -3
        }),
        created_at: new Date('2026-01-02T00:00:00.000Z')
      })
    ]);
    deps.identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'voter-1': voterOne,
      'voter-2': voterTwo
    });

    const result = await service.findVoteEditLogsByDropIdOrThrow(
      'drop-1',
      {
        offset: 10,
        limit: 20,
        sort_direction: PageSortDirection.ASC
      },
      {
        authenticationContext,
        connection
      }
    );

    expect(result).toEqual([
      {
        id: 'log-1',
        old_vote: 5,
        new_vote: 10,
        created_at: new Date('2026-01-01T00:00:00.000Z').getTime(),
        voter: voterOne
      },
      {
        id: 'log-2',
        old_vote: 0,
        new_vote: -3,
        created_at: new Date('2026-01-02T00:00:00.000Z').getTime(),
        voter: voterTwo
      }
    ]);
    expect(deps.dropsDb.findDropByIdWithEligibilityCheck).toHaveBeenCalledWith(
      'drop-1',
      ['group-1'],
      connection
    );
    expect(deps.dropsDb.findDropVoteEditLogEntities).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        offset: 10,
        limit: 20,
        sort_direction: PageSortDirection.ASC
      },
      {
        authenticationContext,
        connection
      }
    );
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).toHaveBeenCalledWith(['voter-1', 'voter-2'], {
      authenticationContext,
      connection
    });
  });

  it('throws for hidden vote edit log drops without fetching logs', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(null);

    await expect(
      service.findVoteEditLogsByDropIdOrThrow(
        'missing-drop',
        {
          offset: 0,
          limit: 20,
          sort_direction: PageSortDirection.DESC
        },
        {
          authenticationContext: AuthenticationContext.notAuthenticated()
        }
      )
    ).rejects.toThrow(NotFoundException);

    expect(deps.dropsDb.findDropVoteEditLogEntities).not.toHaveBeenCalled();
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).not.toHaveBeenCalled();
  });

  it('returns empty vote edit logs without resolving voter identities', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropVoteEditLogEntities.mockResolvedValue([]);

    const result = await service.findVoteEditLogsByDropIdOrThrow(
      'drop-1',
      {
        offset: 0,
        limit: 20,
        sort_direction: PageSortDirection.DESC
      },
      {
        authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
      }
    );

    expect(result).toEqual([]);
    expect(deps.dropsDb.findDropVoteEditLogEntities).toHaveBeenCalled();
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).not.toHaveBeenCalled();
  });

  it('finds visible drop voters sorted by absolute vote', async () => {
    const { service, deps } = createService();
    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const connection = {} as any;
    const voterOne = {
      id: 'voter-1',
      primary_address: '0x1',
      handle: 'alice',
      level: 4,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 0,
        artist_of_memes: 1
      }
    };
    const voterTwo = {
      id: 'voter-2',
      primary_address: '0x2',
      level: 2,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 1,
        artist_of_memes: 0
      }
    };
    deps.dropsDb.findDropVotersByAbsoluteVote.mockResolvedValue([
      {
        voter_id: 'voter-1',
        vote: 7
      },
      {
        voter_id: 'voter-2',
        vote: -4
      }
    ]);
    deps.dropsDb.countDropVotersByAbsoluteVote.mockResolvedValue(42);
    deps.identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'voter-1': voterOne,
      'voter-2': voterTwo
    });

    const result = await service.findVotersByDropIdOrThrow(
      'drop-1',
      {
        page_size: 20,
        page: 2,
        sort_direction: PageSortDirection.ASC
      },
      {
        authenticationContext,
        connection
      }
    );

    expect(result).toEqual({
      page: 2,
      count: 42,
      next: true,
      data: [
        {
          voter: voterOne,
          vote: 7
        },
        {
          voter: voterTwo,
          vote: -4
        }
      ]
    });
    expect(deps.dropsDb.findDropByIdWithEligibilityCheck).toHaveBeenCalledWith(
      'drop-1',
      ['group-1'],
      connection
    );
    expect(deps.dropsDb.findDropVotersByAbsoluteVote).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        page: 2,
        page_size: 20,
        sort_direction: PageSortDirection.ASC
      },
      {
        authenticationContext,
        connection
      }
    );
    expect(deps.dropsDb.countDropVotersByAbsoluteVote).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        drop_id: 'drop-1'
      },
      {
        authenticationContext,
        connection
      }
    );
    expect(deps.dropsDb.getWinnerDropVoters).not.toHaveBeenCalled();
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).toHaveBeenCalledWith(['voter-1', 'voter-2'], {
      authenticationContext,
      connection
    });
  });

  it('finds visible winner drop voters using winner votes', async () => {
    const { service, deps } = createService();
    const authenticationContext =
      AuthenticationContext.fromProfileId('viewer-1');
    const voter = {
      id: 'voter-1',
      primary_address: '0x1',
      level: 3,
      classification: 'PSEUDONYM',
      badges: {
        artist_of_main_stage_submissions: 0,
        artist_of_memes: 0
      }
    };
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(
      makeDrop({ drop_type: DropType.WINNER })
    );
    deps.dropsDb.getWinnerDropVoters.mockResolvedValue([
      {
        voter_id: 'voter-1',
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        votes: -9
      }
    ]);
    deps.dropsDb.countWinnerDropVoters.mockResolvedValue(1);
    deps.identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'voter-1': voter
    });

    const result = await service.findVotersByDropIdOrThrow(
      'drop-1',
      {
        page_size: 20,
        page: 1,
        sort_direction: PageSortDirection.DESC
      },
      {
        authenticationContext
      }
    );

    expect(result).toEqual({
      page: 1,
      count: 1,
      next: false,
      data: [
        {
          voter,
          vote: -9
        }
      ]
    });
    expect(deps.dropsDb.getWinnerDropVoters).toHaveBeenCalledWith(
      {
        drop_id: 'drop-1',
        page: 1,
        page_size: 20,
        direction: PageSortDirection.DESC
      },
      {
        authenticationContext
      }
    );
    expect(deps.dropsDb.countWinnerDropVoters).toHaveBeenCalledWith('drop-1', {
      authenticationContext
    });
    expect(deps.dropsDb.findDropVotersByAbsoluteVote).not.toHaveBeenCalled();
    expect(deps.dropsDb.countDropVotersByAbsoluteVote).not.toHaveBeenCalled();
  });

  it('throws for hidden voter drops without fetching voters', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue(null);

    await expect(
      service.findVotersByDropIdOrThrow(
        'missing-drop',
        {
          page_size: 20,
          page: 1,
          sort_direction: PageSortDirection.DESC
        },
        {
          authenticationContext: AuthenticationContext.notAuthenticated()
        }
      )
    ).rejects.toThrow(NotFoundException);

    expect(deps.dropsDb.findDropVotersByAbsoluteVote).not.toHaveBeenCalled();
    expect(deps.dropsDb.countDropVotersByAbsoluteVote).not.toHaveBeenCalled();
    expect(deps.dropsDb.getWinnerDropVoters).not.toHaveBeenCalled();
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).not.toHaveBeenCalled();
  });

  it('returns an empty voter page without resolving identities', async () => {
    const { service, deps } = createService();
    deps.dropsDb.findDropVotersByAbsoluteVote.mockResolvedValue([]);
    deps.dropsDb.countDropVotersByAbsoluteVote.mockResolvedValue(0);

    const result = await service.findVotersByDropIdOrThrow(
      'drop-1',
      {
        page_size: 20,
        page: 1,
        sort_direction: PageSortDirection.DESC
      },
      {
        authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
      }
    );

    expect(result).toEqual({
      page: 1,
      count: 0,
      next: false,
      data: []
    });
    expect(deps.dropsDb.findDropVotersByAbsoluteVote).toHaveBeenCalled();
    expect(deps.dropsDb.countDropVotersByAbsoluteVote).toHaveBeenCalled();
    expect(
      deps.identityFetcher.getApiIdentityOverviewsByIds
    ).not.toHaveBeenCalled();
  });
});
