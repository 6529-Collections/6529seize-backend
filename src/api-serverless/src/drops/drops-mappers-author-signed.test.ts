import { memeCollaborationsDb } from '@/meme-collaborations/meme-collaborations.db';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { AuthenticationContext } from '@/auth-context';
import { DropEntity, DropPartEntity, DropType } from '@/entities/IDrop';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { directMessageWaveDisplayService } from '@/api/waves/direct-message-wave-display.service';
import { DropsMappers } from './drops.mappers';

function aDropEntity(
  id: string,
  overrides: Partial<DropEntity> = {}
): DropEntity {
  return {
    id,
    serial_no: 1,
    wave_id: 'wave-1',
    author_id: `${id}-author`,
    created_at: 1,
    updated_at: null,
    title: null,
    parts_count: 1,
    drop_type: DropType.CHAT,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    signature: null,
    is_additional_action_promised: null,
    hide_link_preview: false,
    ...overrides
  };
}

function aPart(dropId: string, quotedDropId?: string): DropPartEntity {
  return {
    drop_id: dropId,
    drop_part_id: 1,
    content: `${dropId} content`,
    quoted_drop_id: quotedDropId ?? null,
    quoted_drop_part_id: quotedDropId ? 1 : null,
    wave_id: 'wave-1'
  };
}

// A reply that quotes another drop, its parent (also a root) and one more root.
const ENTITIES = [
  aDropEntity('root-reply', {
    reply_to_drop_id: 'parent',
    reply_to_part_id: 1
  }),
  aDropEntity('parent'),
  aDropEntity('quoted'),
  aDropEntity('root-plain')
];
const PARTS: Record<string, DropPartEntity[]> = {
  'root-reply': [aPart('root-reply', 'quoted')],
  parent: [aPart('parent')],
  quoted: [aPart('quoted')],
  'root-plain': [aPart('root-plain')]
};

function createMapper(signedDropIds: string[]) {
  const dropsDb = {
    getQuoteIds: jest.fn().mockResolvedValue(['quoted']),
    getDropsByIds: jest.fn().mockResolvedValue(ENTITIES),
    getDropsParts: jest.fn().mockResolvedValue(PARTS),
    findMentionsByDropIds: jest.fn().mockResolvedValue([]),
    findDropGroupMentionsByDropIds: jest.fn().mockResolvedValue([]),
    findMentionedWavesByDropIds: jest.fn().mockResolvedValue([]),
    findReferencedNftsByDropIds: jest.fn().mockResolvedValue([]),
    findMetadataByDropIds: jest.fn().mockResolvedValue([]),
    getDropMedia: jest.fn().mockResolvedValue({}),
    getWinDecisionsForDrops: jest.fn().mockResolvedValue({}),
    findDeletedDrops: jest.fn().mockResolvedValue({}),
    findDropIdsOfWavesWhereNegativeVotesAreNotAllowed: jest
      .fn()
      .mockResolvedValue([]),
    countBoostsOfGivenDrops: jest.fn().mockResolvedValue({})
  };
  const dropVotingDb = {
    getParticipationDropsRealtimeRanks: jest.fn().mockResolvedValue({}),
    findDropsTopContributors: jest.fn().mockResolvedValue({}),
    getTallyForDrops: jest.fn().mockResolvedValue({}),
    getWinningDropsTopRaters: jest.fn().mockResolvedValue({}),
    getWinningDropsRatersCount: jest.fn().mockResolvedValue({}),
    getTimeLockedDropsWeightedVotes: jest.fn().mockResolvedValue({}),
    getWeightedDropRates: jest.fn().mockResolvedValue({})
  };
  const moderationDb = { getPresentations: jest.fn().mockResolvedValue({}) };
  const authorSignaturesDb = {
    findAuthorSignedDropIds: jest
      .fn()
      .mockResolvedValue(new Set<string>(signedDropIds))
  };
  const mapper = new DropsMappers(
    { getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([]) } as any,
    {
      getOverviewsByIds: jest.fn().mockResolvedValue({}),
      getDropResolvedIdentitiesByIds: jest.fn().mockResolvedValue({})
    } as any,
    dropsDb as any,
    {
      findWavesByIdsEligibleForRead: jest
        .fn()
        .mockResolvedValue([{ id: 'wave-1' }]),
      findWaveVotingCreditNftsByWaveIds: jest.fn().mockResolvedValue({}),
      whichOfWavesArePinnedByGivenProfile: jest
        .fn()
        .mockResolvedValue(new Set())
    } as any,
    null as any,
    dropVotingDb as any,
    { findCreditLeftForVotingForDrops: jest.fn().mockResolvedValue({}) } as any,
    { getByDropIds: jest.fn().mockResolvedValue(new Map()) } as any,
    null as any,
    { findWaveCurationsByWaveIds: jest.fn().mockResolvedValue([]) } as any,
    { findByDropIds: jest.fn().mockResolvedValue([]) } as any,
    { findByCanonicalIds: jest.fn().mockResolvedValue([]) } as any,
    null as any,
    { getDropAttachments: jest.fn().mockResolvedValue({}) } as any,
    { findPollsByDropIds: jest.fn().mockResolvedValue({}) } as any,
    moderationDb as any,
    authorSignaturesDb
  );
  return { mapper, moderationDb, authorSignaturesDb };
}

function mapRoots(mapper: DropsMappers) {
  return mapper.convertToDropsWithoutWaves(
    ENTITIES.filter((it) => it.id.startsWith('root') || it.id === 'parent'),
    { authenticationContext: AuthenticationContext.notAuthenticated() }
  );
}

describe('DropsMappers author signed drops', () => {
  beforeEach(() => {
    jest.spyOn(memeCollaborationsDb, 'acceptedByDrops').mockResolvedValue({});
    jest
      .spyOn(memeCollaborationsDb, 'presentationByDrops')
      .mockResolvedValue({});
    jest
      .spyOn(competitionAnonymityService, 'hiddenDropIds')
      .mockResolvedValue(new Set());
    jest
      .spyOn(profileWavesDb, 'findSelectedWaveIdsByWaveIds')
      .mockResolvedValue(new Set());
    jest
      .spyOn(
        directMessageWaveDisplayService,
        'resolveWaveDisplayByWaveIdForContext'
      )
      .mockResolvedValue({});
  });

  afterEach(() => jest.restoreAllMocks());

  it('marks signed roots, replies and quotes from one de-duplicated lookup', async () => {
    const { mapper, authorSignaturesDb } = createMapper([
      'root-reply',
      'parent'
    ]);

    const [rootReply, parent, rootPlain] = await mapRoots(mapper);

    expect(rootReply.is_author_signed).toBe(true);
    expect(rootReply.reply_to?.drop?.is_author_signed).toBe(true);
    expect(rootReply.parts[0].quoted_drop?.drop?.is_author_signed).toBe(false);
    expect(parent.is_author_signed).toBe(true);
    expect(rootPlain.is_author_signed).toBe(false);
    expect(authorSignaturesDb.findAuthorSignedDropIds).toHaveBeenCalledTimes(1);
    const [lookedUpIds] =
      authorSignaturesDb.findAuthorSignedDropIds.mock.calls[0];
    expect([...lookedUpIds].sort((a, b) => a.localeCompare(b))).toEqual([
      'parent',
      'quoted',
      'root-plain',
      'root-reply'
    ]);
  });

  it('reports unsigned drops as not author signed', async () => {
    const { mapper } = createMapper([]);

    const drops = await mapRoots(mapper);

    expect(drops.map((it) => it.is_author_signed)).toEqual([
      false,
      false,
      false
    ]);
  });

  it('does not mark a signed drop whose content the viewer cannot see', async () => {
    const { mapper, moderationDb } = createMapper(['root-plain']);
    moderationDb.getPresentations.mockResolvedValue({
      'root-plain': {
        viewer: { author_blocked: false, drop_hidden: false },
        moderation: { status: 'MODERATOR_REMOVED', can_view: false }
      }
    });

    const [, , rootPlain] = await mapRoots(mapper);

    expect(rootPlain.moderation?.can_view).toBe(false);
    expect(rootPlain.is_author_signed).toBe(false);
  });

  it('does not mark a signed drop whose author is anonymous', async () => {
    const { mapper } = createMapper(['root-plain']);
    jest
      .spyOn(competitionAnonymityService, 'hiddenDropIds')
      .mockResolvedValue(new Set(['root-plain']));

    const [, , rootPlain] = await mapRoots(mapper);

    expect(rootPlain.author).toMatchObject({ is_anonymous: true });
    expect(rootPlain.is_author_signed).toBe(false);
  });
});
