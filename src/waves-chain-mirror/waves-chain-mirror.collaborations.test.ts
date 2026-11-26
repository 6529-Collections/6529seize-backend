import { competitionMainStageRepository } from '@/competitions/competition-main-stage.repository';
import { MemeCollaborationsService } from '@/meme-collaborations/meme-collaborations.service';
import { uuid } from '@/tests/fixtures/waves-chain-mirror.fixture';
import { nativeEntryModel } from './waves-chain-mirror.apply';
import {
  collaborationCheck,
  CollaborationReads
} from './waves-chain-mirror.collaborations';
import { NativeEntryContent } from './waves-chain-mirror.native-entries';

const C = uuid(1);
const WAVE = uuid(900);
const DROP = `0x${'e1'.repeat(32)}`;

const content = (
  fields: Partial<NativeEntryContent> = {}
): NativeEntryContent => ({
  title: null,
  parts: [
    {
      content: 'x',
      quotedDropId: null,
      quotedDropPartId: null,
      media: [
        {
          url: 'https://media.test/a.png',
          mimeType: 'image/png',
          mediaUploadId: null
        }
      ]
    }
  ],
  metadata: [{ dataKey: 'memeName', dataValue: 'A meme' }],
  referencedNfts: [],
  mentionedUsers: [],
  mentionedWaves: [],
  mentionedGroups: [],
  hideLinkPreview: false,
  isAdditionalActionPromised: null,
  collaboratorIds: [],
  attachmentsLeftOut: 0,
  ...fields
});

const modelOf = (fields: Partial<NativeEntryContent> = {}) =>
  nativeEntryModel({
    entryRowId: uuid(41),
    dropId: DROP,
    waveId: WAVE,
    authorId: 'author',
    createdAt: 1,
    configVersion: 1,
    content: content(fields)
  });

const reads = (
  profiles: { id: string; handle: string | null }[],
  mainStage = true
): CollaborationReads & { profiles: jest.Mock } => ({
  isMainStage: jest.fn().mockResolvedValue(mainStage),
  profiles: jest.fn(async (ids: string[]) =>
    profiles.filter((p) => ids.includes(p.id))
  )
});

/** The three manifests the mirror's own checks let through. */
const CASES = {
  'an author with no profiles row': {
    fields: {},
    profiles: [],
    reason: 'collaboration_profile_missing',
    delay: true,
    thrown: 'All collaborating artists must have an available profile'
  },
  'collaborators on an entry with no memeName': {
    fields: { metadata: [], collaboratorIds: ['collab-1'] },
    profiles: [
      { id: 'author', handle: 'a' },
      { id: 'collab-1', handle: 'c' }
    ],
    reason: 'collaboration_not_artwork',
    delay: false,
    thrown: 'Collaborator invitations require a new artwork submission'
  },
  'Memes artwork whose additional_media is not JSON': {
    fields: {
      metadata: [
        { dataKey: 'memeName', dataValue: 'A meme' },
        { dataKey: 'additional_media', dataValue: 'not json' }
      ]
    },
    profiles: [{ id: 'author', handle: 'a' }],
    reason: 'collaboration_artwork_metadata',
    delay: false,
    thrown: 'Invalid artwork preview metadata'
  }
};

describe('collaborationCheck', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(Object.entries(CASES))(
    'refuses %s, where the collaboration write throws',
    async (_name, c) => {
      expect(
        await collaborationCheck(modelOf(c.fields), C, reads(c.profiles))
      ).toEqual({ ok: false, reason: c.reason, delay: c.delay });
      // The write itself refuses the same entry, inside a transaction.
      jest
        .spyOn(competitionMainStageRepository, 'isDesignated')
        .mockResolvedValue(true);
      const db = {
        context: async () => null,
        profiles: async (ids: string[]) =>
          c.profiles.filter((p) => ids.includes(p.id)),
        query: async () => [
          { participation_terms: null, participation_config: '{}' }
        ],
        invitations: async () => []
      };
      await expect(
        new MemeCollaborationsService(db as never).onWrite(
          modelOf(c.fields),
          DROP,
          { connection: {} as never },
          C
        )
      ).rejects.toThrow(c.thrown);
    }
  );

  it('lets through an entry with no artwork and no invitations, reading nothing', async () => {
    const r = reads([]);
    expect(await collaborationCheck(modelOf({ metadata: [] }), C, r)).toEqual({
      ok: true
    });
    expect(r.profiles).not.toHaveBeenCalled();
    expect(r.isMainStage).not.toHaveBeenCalled();
  });

  it('lets through artwork outside the Main Stage without invitations, and Main Stage artwork whose artists have profiles', async () => {
    expect(await collaborationCheck(modelOf(), C, reads([], false))).toEqual({
      ok: true
    });
    expect(
      await collaborationCheck(
        modelOf({ collaboratorIds: ['collab-1'] }),
        C,
        reads([
          { id: 'author', handle: 'a' },
          { id: 'collab-1', handle: 'c' }
        ])
      )
    ).toEqual({ ok: true });
  });

  it('refuses invitations outside the Main Stage, twice to one artist, or to the author', async () => {
    const profiles = [
      { id: 'author', handle: 'a' },
      { id: 'collab-1', handle: 'c' }
    ];
    expect(
      await collaborationCheck(
        modelOf({ collaboratorIds: ['collab-1'] }),
        C,
        reads(profiles, false)
      )
    ).toEqual({
      ok: false,
      reason: 'collaboration_outside_main_stage',
      delay: false
    });
    for (const ids of [['collab-1', 'collab-1'], ['author']]) {
      expect(
        await collaborationCheck(
          modelOf({ collaboratorIds: ids }),
          C,
          reads(profiles)
        )
      ).toEqual({ ok: false, reason: 'collaboration_invitees', delay: false });
    }
  });

  it('refuses an artist whose profile has no handle', async () => {
    expect(
      await collaborationCheck(
        modelOf(),
        C,
        reads([{ id: 'author', handle: null }])
      )
    ).toEqual({
      ok: false,
      reason: 'collaboration_profile_missing',
      delay: true
    });
  });
});
