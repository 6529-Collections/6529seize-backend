import { memeCollaborationsDb } from '@/meme-collaborations/meme-collaborations.db';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { directMessageWaveDisplayService } from '@/api/waves/direct-message-wave-display.service';
import { DropsMappers } from './drops.mappers';

const WAVE_GROUPS: Record<string, string | null> = {
  'public-wave': null,
  'member-wave': 'member-group',
  'other-wave': 'other-group'
};

function aDropEntity(id: string, waveId: string): any {
  return {
    id,
    serial_no: 1,
    wave_id: waveId,
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
    hide_link_preview: false
  };
}

function aPart(dropId: string, content: string, quotedDropId?: string): any {
  return {
    drop_id: dropId,
    drop_part_id: 1,
    content,
    quoted_drop_id: quotedDropId ?? null,
    quoted_drop_part_id: quotedDropId ? 1 : null
  };
}

function relatedData(entities: any[], parts: any[], deletedDrops = {}): any {
  return {
    dropsRanks: {},
    submissionDropsVotingRanges: {},
    mentions: [],
    mentionedGroups: [],
    mentionedWaves: [],
    referencedNfts: [],
    metadata: [],
    dropsVoteCounts: {},
    dropsTopVoters: {},
    dropMedia: {},
    dropAttachments: {},
    attachmentsById: {},
    dropsParts: parts.reduce(
      (acc, part) => ({ ...acc, [part.drop_id]: [part] }),
      {}
    ),
    winDecisions: {},
    winningDropsTopRaters: {},
    winningDropsRatersCounts: {},
    winningDropsRatingsByVoter: {},
    subscribedActions: {},
    deletedDrops,
    allEntities: entities,
    weightedDropsRanks: {},
    weightedDropsRates: {},
    dropsInWavesWhereNegativeVotesAreNotAllowed: [],
    dropReactions: new Map(),
    boostsCount: {},
    boostsByAuthenticatedUser: new Set(),
    bookmarksByAuthenticatedUser: new Set(),
    dropPollsByDropId: {},
    rootDropNftLinksByDropId: {},
    authorSignedDropIds: new Set()
  };
}

function createMapper(viewerGroups: string[]) {
  const wavesApiDb = {
    findWavesByIdsEligibleForRead: jest.fn(
      async (waveIds: string[], groupIds: string[]) =>
        waveIds
          .filter((waveId) => {
            const groupId = WAVE_GROUPS[waveId];
            return groupId === null || groupIds.includes(groupId);
          })
          .map((id) => ({ id }))
    ),
    findWaveVotingCreditNftsByWaveIds: jest.fn().mockResolvedValue({}),
    whichOfWavesArePinnedByGivenProfile: jest.fn().mockResolvedValue(new Set())
  };
  const mapper = new DropsMappers(
    {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(viewerGroups)
    } as any,
    {
      getOverviewsByIds: jest.fn().mockResolvedValue({}),
      getDropResolvedIdentitiesByIds: jest.fn().mockResolvedValue({})
    } as any,
    null as any,
    wavesApiDb as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    { findWaveCurationsByWaveIds: jest.fn().mockResolvedValue([]) } as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    { getPresentations: jest.fn().mockResolvedValue({}) } as any
  );
  return { mapper, wavesApiDb };
}

describe('DropsMappers quoted drop visibility', () => {
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

  async function mapRootDrops(
    viewerGroups: string[],
    authenticationContext: AuthenticationContext,
    data: any
  ) {
    const { mapper, wavesApiDb } = createMapper(viewerGroups);
    jest.spyOn(mapper as any, 'getAllDropsRelatedData').mockResolvedValue(data);
    const roots = data.allEntities.filter((it: any) =>
      it.id.startsWith('root')
    );
    const drops = await mapper.convertToDropsWithoutWaves(roots, {
      authenticationContext
    });
    return { drops, wavesApiDb };
  }

  it.each([DropType.CHAT, DropType.PARTICIPATORY, DropType.COMPETITION])(
    'conceals the author of an embedded anonymous entry presented as %s while preserving its content',
    async (dropType) => {
      jest
        .spyOn(competitionAnonymityService, 'hiddenDropIds')
        .mockImplementation(
          async (ids) => new Set(ids.filter((id) => id === 'anonymous-entry'))
        );
      const entry = aDropEntity('anonymous-entry', 'public-wave');
      entry.drop_type = dropType;
      const data = relatedData(
        [aDropEntity('root-1', 'public-wave'), entry],
        [
          aPart('root-1', 'discussion', 'anonymous-entry'),
          aPart('anonymous-entry', 'I chose this public text')
        ]
      );
      const { drops } = await mapRootDrops(
        [],
        AuthenticationContext.notAuthenticated(),
        data
      );
      const quoted = drops[0].parts[0].quoted_drop?.drop;
      expect(quoted?.author).toMatchObject({
        handle: 'Anonymous',
        is_anonymous: true,
        primary_address: ''
      });
      expect(quoted?.author.id).not.toBe('anonymous-entry-author');
      expect(quoted?.parts[0].content).toBe('I chose this public text');
    }
  );

  it.each([DropType.CHAT, DropType.COMPETITION])(
    'conceals a direct anonymous entry presented as %s',
    async (dropType) => {
      jest
        .spyOn(competitionAnonymityService, 'hiddenDropIds')
        .mockImplementation(
          async (ids) => new Set(ids.filter((id) => id === 'root-entry'))
        );
      const entry = aDropEntity('root-entry', 'public-wave');
      entry.drop_type = dropType;
      const data = relatedData(
        [entry],
        [aPart(entry.id, 'A public submission')]
      );
      const { drops } = await mapRootDrops(
        [],
        AuthenticationContext.notAuthenticated(),
        data
      );
      expect(drops[0].author).toMatchObject({
        handle: 'Anonymous',
        is_anonymous: true
      });
      expect(drops[0].author.id).not.toBe(entry.author_id);
      expect(drops[0].parts[0].content).toBe('A public submission');
    }
  );

  it('embeds quotes from readable waves and keeps only the reference otherwise', async () => {
    const entities = [
      aDropEntity('root-1', 'public-wave'),
      aDropEntity('root-2', 'public-wave'),
      aDropEntity('readable', 'member-wave'),
      aDropEntity('restricted', 'other-wave')
    ];
    const parts = [
      aPart('root-1', 'first', 'readable'),
      aPart('root-2', 'second', 'restricted'),
      aPart('readable', 'member content'),
      aPart('restricted', 'restricted content')
    ];

    const { drops, wavesApiDb } = await mapRootDrops(
      ['member-group'],
      AuthenticationContext.fromProfileId('viewer'),
      relatedData(entities, parts)
    );

    expect(drops[0].parts[0].quoted_drop?.drop?.parts[0].content).toBe(
      'member content'
    );
    expect(drops[1].parts[0].quoted_drop).toEqual({
      is_deleted: false,
      drop_id: 'restricted',
      drop_part_id: 1,
      drop: undefined
    });
    expect(JSON.stringify(drops)).not.toContain('restricted content');
    expect(wavesApiDb.findWavesByIdsEligibleForRead).toHaveBeenCalledTimes(1);
    expect(wavesApiDb.findWavesByIdsEligibleForRead).toHaveBeenCalledWith(
      ['member-wave', 'other-wave'],
      ['member-group'],
      undefined
    );
  });

  it('only embeds quotes from public waves for anonymous viewers', async () => {
    const entities = [
      aDropEntity('root-1', 'public-wave'),
      aDropEntity('root-2', 'public-wave'),
      aDropEntity('public-quoted', 'public-wave'),
      aDropEntity('member-quoted', 'member-wave')
    ];
    const parts = [
      aPart('root-1', 'first', 'public-quoted'),
      aPart('root-2', 'second', 'member-quoted'),
      aPart('public-quoted', 'public content'),
      aPart('member-quoted', 'member content')
    ];

    const { drops } = await mapRootDrops(
      [],
      AuthenticationContext.notAuthenticated(),
      relatedData(entities, parts)
    );

    expect(drops[0].parts[0].quoted_drop?.drop?.id).toBe('public-quoted');
    expect(drops[1].parts[0].quoted_drop?.drop).toBeUndefined();
    expect(JSON.stringify(drops)).not.toContain('member content');
  });

  it('reports deletion state only for quotes in readable waves', async () => {
    const entities = [
      aDropEntity('root-1', 'public-wave'),
      aDropEntity('root-2', 'public-wave')
    ];
    const parts = [
      aPart('root-1', 'first', 'deleted-readable'),
      aPart('root-2', 'second', 'deleted-restricted')
    ];
    const deletedDrops = {
      'deleted-readable': { id: 'deleted-readable', wave_id: 'member-wave' },
      'deleted-restricted': { id: 'deleted-restricted', wave_id: 'other-wave' }
    };

    const { drops } = await mapRootDrops(
      ['member-group'],
      AuthenticationContext.fromProfileId('viewer'),
      relatedData(entities, parts, deletedDrops)
    );

    expect(drops[0].parts[0].quoted_drop).toMatchObject({ is_deleted: true });
    expect(drops[1].parts[0].quoted_drop).toMatchObject({ is_deleted: false });
  });

  it('does not query wave access when no drop quotes another', async () => {
    const entities = [aDropEntity('root-1', 'member-wave')];

    const { wavesApiDb } = await mapRootDrops(
      ['member-group'],
      AuthenticationContext.fromProfileId('viewer'),
      relatedData(entities, [aPart('root-1', 'plain')])
    );

    expect(wavesApiDb.findWavesByIdsEligibleForRead).not.toHaveBeenCalled();
  });
});
