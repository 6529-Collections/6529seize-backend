import { AuthenticationContext } from '@/auth-context';
import {
  AttachmentEntity,
  AttachmentKind,
  AttachmentStatus,
  DropAttachmentEntity
} from '@/entities/IAttachment';
import { DropEntity, DropType } from '@/entities/IDrop';
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';
import { ApiDropGroupMention } from '@/api/generated/models/ApiDropGroupMention';
import { ApiDropMainType } from '@/api/generated/models/ApiDropMainType';
import { ApiProfileClassification } from '@/api/generated/models/ApiProfileClassification';
import { ApiSubmissionDropStatus } from '@/api/generated/models/ApiSubmissionDropStatus';
import { ApiDropMapper } from './api-drop.mapper';

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
    is_additional_action_promised: null,
    hide_link_preview: false,
    ...overrides
  };
}

function makeIdentity(id: string) {
  return {
    id,
    primary_address: `${id}-wallet`,
    level: 1,
    classification: ApiProfileClassification.Pseudonym,
    badges: {
      artist_of_main_stage_submissions: 0,
      artist_of_memes: 0
    }
  };
}

function createMapper() {
  const identityFetcher = {
    getApiIdentityOverviewsByIds: jest.fn().mockResolvedValue({
      'author-1': makeIdentity('author-1')
    })
  };
  const identitiesDb = {
    findProfileHandlesByIds: jest.fn().mockResolvedValue({})
  };
  const dropsDb = {
    getDropPartOnes: jest.fn().mockResolvedValue({}),
    getDropPartOneMedia: jest.fn().mockResolvedValue({}),
    findReferencedNftsByDropIds: jest.fn().mockResolvedValue([]),
    findMentionsByDropIds: jest.fn().mockResolvedValue([]),
    findDropGroupMentionsByDropIds: jest.fn().mockResolvedValue([]),
    findMentionedWavesByDropIds: jest.fn().mockResolvedValue([]),
    findDropIdsWithMetadata: jest.fn().mockResolvedValue(new Set<string>()),
    findMetadataByDropIds: jest.fn().mockResolvedValue([]),
    countBoostsOfGivenDrops: jest.fn().mockResolvedValue({}),
    whichOfGivenDropsAreBoostedByIdentity: jest
      .fn()
      .mockResolvedValue(new Set<string>()),
    getReplyPreviewsByDropIds: jest.fn().mockResolvedValue({})
  };
  const attachmentsDb = {
    getDropPartOneAttachments: jest.fn().mockResolvedValue({}),
    findAttachmentsByIds: jest.fn().mockResolvedValue({})
  };
  const identitySubscriptionsDb = {
    findIdentitySubscriptionActionsOfTargets: jest.fn().mockResolvedValue({})
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };
  const wavesApiDb = {
    findWaveMentionOverviewsByIds: jest.fn().mockResolvedValue({})
  };
  const directMessageWaveDisplayService = {
    resolveWaveDisplayByWaveIdForContext: jest.fn().mockResolvedValue({})
  };
  const reactionsDb = {
    getCountersByDropIds: jest.fn().mockResolvedValue(new Map())
  };
  const dropBookmarksDb = {
    findBookmarkedDropIds: jest.fn().mockResolvedValue(new Set<string>())
  };
  const dropVotingDb = {
    getDropV2SubmissionVotingSummaries: jest.fn().mockResolvedValue({}),
    getWinningDropsRatingsByVoter: jest.fn().mockResolvedValue({})
  };
  const dropVotingService = {
    findCreditLeftForVotingForDrops: jest.fn().mockResolvedValue({})
  };
  const dropPollsDb = {
    findPollsByDropIds: jest.fn().mockResolvedValue({})
  };
  const dropNftLinksDb = {
    findByDropIds: jest.fn().mockResolvedValue([])
  };
  const nftLinksDb = {
    findByCanonicalIds: jest.fn().mockResolvedValue([])
  };
  const nftLinkResolvingService = {
    refreshStaleTrackingForUrls: jest.fn().mockResolvedValue(undefined)
  };

  return {
    mapper: new ApiDropMapper(
      identityFetcher as any,
      identitiesDb as any,
      dropsDb as any,
      attachmentsDb as any,
      identitySubscriptionsDb as any,
      userGroupsService as any,
      wavesApiDb as any,
      directMessageWaveDisplayService as any,
      reactionsDb as any,
      dropBookmarksDb as any,
      dropVotingDb as any,
      dropVotingService as any,
      dropPollsDb as any,
      dropNftLinksDb as any,
      nftLinksDb as any,
      nftLinkResolvingService as any
    ),
    deps: {
      identityFetcher,
      identitiesDb,
      dropsDb,
      attachmentsDb,
      identitySubscriptionsDb,
      userGroupsService,
      wavesApiDb,
      directMessageWaveDisplayService,
      reactionsDb,
      dropBookmarksDb,
      dropVotingDb,
      dropVotingService,
      dropPollsDb,
      dropNftLinksDb,
      nftLinksDb,
      nftLinkResolvingService
    }
  };
}

describe('ApiDropMapper', () => {
  it('maps part one content and omits missing optional fields', async () => {
    const { mapper, deps } = createMapper();
    const drop = makeDrop({ hide_link_preview: true });
    deps.dropsDb.getDropPartOnes.mockResolvedValue({
      'drop-1': {
        drop_id: 'drop-1',
        drop_part_id: 1,
        content: 'part one text',
        quoted_drop_id: null,
        quoted_drop_part_id: null,
        wave_id: 'wave-1'
      }
    });
    deps.dropsDb.getDropPartOneMedia.mockResolvedValue({
      'drop-1': [
        {
          id: 'media-1',
          drop_id: 'drop-1',
          drop_part_id: 1,
          url: 'https://example.test/image.png',
          mime_type: 'image/png',
          wave_id: 'wave-1'
        }
      ]
    });
    deps.reactionsDb.getCountersByDropIds.mockResolvedValue(
      new Map([
        [
          'drop-1',
          {
            reactions: [{ reaction: ':+1:', count: 3 }],
            context_profile_reaction: ':+1:'
          }
        ]
      ])
    );
    deps.dropsDb.countBoostsOfGivenDrops.mockResolvedValue({ 'drop-1': 2 });
    deps.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTargets.mockResolvedValue(
      { 'drop-1': ['DROP_REPLIED'] }
    );

    const ctx = {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    };
    const result = await mapper.mapDrops([drop], ctx);

    expect(result['drop-1']).toMatchObject({
      id: 'drop-1',
      serial_no: 1,
      created_at: 100,
      is_signed: false,
      hide_link_preview: true,
      content: 'part one text',
      media: [
        {
          url: 'https://example.test/image.png',
          mime_type: 'image/png'
        }
      ],
      parts_count: 1,
      author: makeIdentity('author-1'),
      drop_type: ApiDropMainType.Chat,
      reactions: [{ reaction: ':+1:', count: 3 }],
      boosts: 2,
      context_profile_context: {
        reaction: ':+1:',
        boosted: false,
        bookmarked: false,
        subscribed: true
      }
    });
    expect(result['drop-1']).not.toHaveProperty('title');
    expect(result['drop-1']).not.toHaveProperty('updated_at');
    expect(result['drop-1']).not.toHaveProperty('attachments');
    expect(result['drop-1']).not.toHaveProperty('referenced_nfts');
    expect(result['drop-1']).not.toHaveProperty('has_metadata');
    expect(deps.dropsDb.findDropIdsWithMetadata).not.toHaveBeenCalled();
  });

  it('maps chat poll details', async () => {
    const { mapper, deps } = createMapper();
    deps.dropsDb.getDropPartOnes.mockResolvedValue({
      'drop-1': {
        drop_id: 'drop-1',
        drop_part_id: 1,
        content: 'poll text',
        quoted_drop_id: null,
        quoted_drop_part_id: null,
        wave_id: 'wave-1'
      }
    });
    deps.dropPollsDb.findPollsByDropIds.mockResolvedValue({
      'drop-1': {
        id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        closing_time: Date.now() + 10_000,
        multichoice: true,
        voted: [2],
        options: [
          {
            poll_id: 'poll-1',
            wave_id: 'wave-1',
            drop_id: 'drop-1',
            option_no: 2,
            option_string: 'Second',
            votes: 3
          },
          {
            poll_id: 'poll-1',
            wave_id: 'wave-1',
            drop_id: 'drop-1',
            option_no: 1,
            option_string: 'First',
            votes: 5
          }
        ]
      }
    });

    const result = await mapper.mapDrops([makeDrop()], {
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    expect(result['drop-1'].poll).toMatchObject({
      id: 'poll-1',
      multichoice: true,
      is_open: true,
      voted: [2],
      options: [
        { option_no: 1, option_string: 'First', votes: 5 },
        { option_no: 2, option_string: 'Second', votes: 3 }
      ]
    });
  });

  it('uses provided eligible groups for mentioned wave overviews', async () => {
    const { mapper, deps } = createMapper();
    const ctx = {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    };
    deps.dropsDb.findMentionedWavesByDropIds.mockResolvedValue([
      {
        id: 'mention-1',
        drop_id: 'drop-1',
        wave_id: 'mentioned-wave-1',
        wave_name_in_content: 'wave-name'
      }
    ]);
    deps.wavesApiDb.findWaveMentionOverviewsByIds.mockResolvedValue({
      'mentioned-wave-1': {
        id: 'mentioned-wave-1',
        name: 'Mentioned Wave',
        picture: null,
        visibility_group_id: null,
        participation_group_id: null,
        chat_group_id: null,
        admin_group_id: null,
        voting_group_id: null,
        is_direct_message: false
      }
    });

    await mapper.mapDrops([makeDrop()], ctx, {
      groupIdsUserIsEligibleFor: ['visible-group']
    });

    expect(
      deps.userGroupsService.getGroupsUserIsEligibleFor
    ).not.toHaveBeenCalled();
    expect(deps.wavesApiDb.findWaveMentionOverviewsByIds).toHaveBeenCalledWith(
      ['mentioned-wave-1'],
      ['visible-group'],
      ctx
    );
  });

  it('maps attachments, mentions, replies, and submission voting context', async () => {
    const { mapper, deps } = createMapper();
    const drop = makeDrop({
      id: 'drop-2',
      serial_no: 2,
      drop_type: DropType.PARTICIPATORY,
      is_additional_action_promised: true,
      title: 'Title',
      updated_at: 120,
      reply_to_drop_id: 'reply-1',
      reply_to_part_id: 1,
      signature: 'signature'
    });
    const dropAttachment: DropAttachmentEntity = {
      drop_id: 'drop-2',
      drop_part_id: 1,
      attachment_id: 'attachment-1',
      wave_id: 'wave-1'
    };
    const attachment: AttachmentEntity = {
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
      ipfs_url: 'ipfs://file',
      error_reason: null,
      created_at: 1,
      updated_at: 2
    };
    deps.identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'author-1': makeIdentity('author-1')
    });
    deps.dropsDb.getDropPartOnes.mockResolvedValue({
      'drop-2': {
        drop_id: 'drop-2',
        drop_part_id: 1,
        content: 'submission text',
        quoted_drop_id: null,
        quoted_drop_part_id: null,
        wave_id: 'wave-1'
      }
    });
    deps.attachmentsDb.getDropPartOneAttachments.mockResolvedValue({
      'drop-2': [dropAttachment]
    });
    deps.attachmentsDb.findAttachmentsByIds.mockResolvedValue({
      'attachment-1': attachment
    });
    deps.dropsDb.findReferencedNftsByDropIds.mockResolvedValue([
      {
        id: 'ref-1',
        drop_id: 'drop-2',
        contract: '0xcontract',
        token: '1',
        name: 'NFT',
        wave_id: 'wave-1'
      }
    ]);
    deps.dropsDb.findMentionsByDropIds.mockResolvedValue([
      {
        id: 'mention-1',
        drop_id: 'drop-2',
        mentioned_profile_id: 'mentioned-1',
        handle_in_content: 'old-handle',
        wave_id: 'wave-1'
      }
    ]);
    deps.identitiesDb.findProfileHandlesByIds.mockResolvedValue({
      'mentioned-1': 'new-handle'
    });
    deps.dropsDb.findDropGroupMentionsByDropIds.mockResolvedValue([
      {
        drop_id: 'drop-2',
        mentioned_group: DropGroupMention.ALL
      }
    ]);
    deps.dropsDb.findMentionedWavesByDropIds.mockResolvedValue([
      {
        id: 'wave-mention-1',
        drop_id: 'drop-2',
        wave_id: 'mentioned-wave-1',
        wave_name_in_content: 'wave-name'
      }
    ]);
    deps.userGroupsService.getGroupsUserIsEligibleFor.mockResolvedValue([
      'group-1'
    ]);
    deps.wavesApiDb.findWaveMentionOverviewsByIds.mockResolvedValue({
      'mentioned-wave-1': {
        id: 'mentioned-wave-1',
        name: 'Mentioned Wave',
        picture: 'wave.png'
      }
    });
    deps.dropsDb.getReplyPreviewsByDropIds.mockResolvedValue({
      'reply-1': {
        id: 'reply-1',
        serial_no: 1,
        content: 'reply text',
        author_handle: 'reply-author',
        author_pfp: 'reply.png'
      }
    });
    deps.dropVotingDb.getDropV2SubmissionVotingSummaries.mockResolvedValue({
      'drop-2': {
        drop_id: 'drop-2',
        status: DropType.PARTICIPATORY,
        is_open: true,
        total_votes_given: 7,
        current_calculated_vote: 8,
        predicted_final_vote: 9,
        voters_count: 3,
        place: 4,
        over_threshold_since_ms: 1_234,
        won_at: null,
        forbid_negative_votes: true
      }
    });
    deps.dropVotingService.findCreditLeftForVotingForDrops.mockResolvedValue({
      'drop-2': {
        min: -5,
        current: 1,
        max: 10
      }
    });
    deps.dropsDb.findDropIdsWithMetadata.mockResolvedValue(new Set(['drop-2']));

    const ctx = {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    };
    const result = await mapper.mapDrops([drop], ctx);

    expect(result['drop-2']).toMatchObject({
      id: 'drop-2',
      title: 'Title',
      updated_at: 120,
      is_signed: true,
      content: 'submission text',
      attachments: [
        {
          attachment_id: 'attachment-1',
          file_name: 'file.pdf',
          url: 'ipfs://file'
        }
      ],
      referenced_nfts: [
        {
          contract: '0xcontract',
          token: '1',
          name: 'NFT'
        }
      ],
      mentioned_users: [
        {
          mentioned_profile_id: 'mentioned-1',
          handle_in_content: 'old-handle',
          current_handle: 'new-handle'
        }
      ],
      mentioned_groups: [ApiDropGroupMention.All],
      mentioned_waves: [
        {
          id: 'mentioned-wave-1',
          in_content: 'wave-name',
          name: 'Mentioned Wave',
          pfp: 'wave.png'
        }
      ],
      reply_to_drop: {
        id: 'reply-1',
        serial_no: 1,
        content: 'reply text',
        author: {
          handle: 'reply-author',
          pfp: 'reply.png'
        }
      },
      submission_context: {
        status: ApiSubmissionDropStatus.Active,
        has_metadata: true,
        is_additional_action_promised: true,
        over_threshold_since_ms: 1_234,
        voting: {
          is_open: true,
          total_votes_given: 7,
          current_calculated_vote: 8,
          predicted_final_vote: 9,
          voters_count: 3,
          place: 4,
          context_profile_context: {
            can_vote: true,
            min: 0,
            current: 1,
            max: 10
          }
        }
      }
    });
    expect(deps.dropsDb.findDropIdsWithMetadata).toHaveBeenCalledWith(
      ['drop-2'],
      ctx
    );
  });

  it('omits additional action promise from submission context when null', async () => {
    const { mapper, deps } = createMapper();
    const drop = makeDrop({
      id: 'drop-null',
      drop_type: DropType.PARTICIPATORY,
      is_additional_action_promised: null
    });
    deps.dropsDb.getDropPartOnes.mockResolvedValue({
      'drop-null': {
        drop_id: 'drop-null',
        drop_part_id: 1,
        content: 'submission text',
        quoted_drop_id: null,
        quoted_drop_part_id: null,
        wave_id: 'wave-1'
      }
    });
    deps.dropVotingDb.getDropV2SubmissionVotingSummaries.mockResolvedValue({
      'drop-null': {
        drop_id: 'drop-null',
        status: DropType.PARTICIPATORY,
        is_open: false,
        total_votes_given: 0,
        current_calculated_vote: 0,
        predicted_final_vote: 0,
        voters_count: 0,
        place: 1,
        over_threshold_since_ms: null,
        won_at: null,
        forbid_negative_votes: false
      }
    });

    const result = await mapper.mapDrops([drop], {
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    expect(result['drop-null'].submission_context).toMatchObject({
      status: ApiSubmissionDropStatus.Active,
      has_metadata: false,
      voting: {
        is_open: false,
        total_votes_given: 0,
        current_calculated_vote: 0,
        predicted_final_vote: 0,
        voters_count: 0,
        place: 1
      }
    });
    expect(result['drop-null'].submission_context).not.toHaveProperty(
      'is_additional_action_promised'
    );
  });

  it('maps priority metadata whenever additional media metadata exists', async () => {
    const { mapper, deps } = createMapper();
    const drop = makeDrop({
      id: 'drop-3',
      wave_id: 'other-wave',
      drop_type: DropType.WINNER
    });
    deps.dropsDb.findMetadataByDropIds.mockResolvedValue([
      {
        id: 'metadata-1',
        drop_id: 'drop-3',
        data_key: 'additional_media',
        data_value: '{"preview_image":"https://example.com/image.png"}',
        wave_id: 'other-wave'
      },
      {
        id: 'metadata-2',
        drop_id: 'drop-3',
        data_key: 'artist',
        data_value: 'Artist',
        wave_id: 'other-wave'
      }
    ]);

    const result = await mapper.mapDrops([drop], {
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    expect(deps.dropsDb.findMetadataByDropIds).toHaveBeenCalledWith(
      ['drop-3'],
      undefined
    );
    expect(result['drop-3']).toMatchObject({
      drop_type: ApiDropMainType.Submission,
      priority_metadata: [
        {
          data_key: 'additional_media',
          data_value: '{"preview_image":"https://example.com/image.png"}'
        }
      ]
    });
  });
});
