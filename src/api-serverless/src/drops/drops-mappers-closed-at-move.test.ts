import { memeCollaborationsDb } from '@/meme-collaborations/meme-collaborations.db';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { AuthenticationContext } from '@/auth-context';
import { DropEntity, DropPartEntity, DropType } from '@/entities/IDrop';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { directMessageWaveDisplayService } from '@/api/waves/direct-message-wave-display.service';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';
import { DropsMappers } from './drops.mappers';

const FREEZE = Date.now() - 2 * 86_400_000;
const NAMES = ['WAVES_FREEZE_AT', 'WAVES_SWITCH_ON_AT'];

function aDrop(id: string, waveId: string): DropEntity {
  return {
    id,
    serial_no: 1,
    wave_id: waveId,
    author_id: `${id}-author`,
    created_at: FREEZE - 60_000,
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

function aPart(drop: DropEntity): DropPartEntity {
  return {
    drop_id: drop.id,
    drop_part_id: 1,
    content: `${drop.id} content`,
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: drop.wave_id
  };
}

const DROPS = [
  aDrop('moved-drop', 'moved-wave'),
  aDrop('staying-drop', 'staying-wave')
];

function aPoll(drop: DropEntity) {
  return {
    id: `${drop.id}-poll`,
    wave_id: drop.wave_id,
    drop_id: drop.id,
    closing_time: Date.now() + 86_400_000,
    created_at: drop.created_at,
    multichoice: false,
    anonymous: false,
    only_droppers_can_respond: false,
    voted: [],
    options: []
  };
}

function createMapper() {
  const dropsDb = {
    getQuoteIds: jest.fn().mockResolvedValue([]),
    getDropsByIds: jest.fn().mockResolvedValue(DROPS),
    getDropsParts: jest
      .fn()
      .mockResolvedValue(
        Object.fromEntries(DROPS.map((drop) => [drop.id, [aPart(drop)]]))
      ),
    findMentionsByDropIds: jest.fn().mockResolvedValue([]),
    findDropGroupMentionsByDropIds: jest.fn().mockResolvedValue([]),
    findMentionedWavesByDropIds: jest.fn().mockResolvedValue([]),
    findReferencedNftsByDropIds: jest.fn().mockResolvedValue([]),
    findMetadataByDropIds: jest.fn().mockResolvedValue([]),
    getDropMedia: jest.fn().mockResolvedValue({}),
    getWinDecisionsForDrops: jest.fn().mockResolvedValue({}),
    findDeletedDrops: jest.fn().mockResolvedValue({}),
    findCollapsedReplyRoots: jest.fn().mockResolvedValue({}),
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
  return new DropsMappers(
    { getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([]) } as any,
    {
      getOverviewsByIds: jest.fn().mockResolvedValue({}),
      getDropResolvedIdentitiesByIds: jest.fn().mockResolvedValue({})
    } as any,
    dropsDb as any,
    {
      findWavesByIdsEligibleForRead: jest
        .fn()
        .mockResolvedValue([{ id: 'moved-wave' }, { id: 'staying-wave' }]),
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
    {
      findPollsByDropIds: jest
        .fn()
        .mockResolvedValue(
          Object.fromEntries(DROPS.map((drop) => [drop.id, aPoll(drop)]))
        )
    } as any,
    { getPresentations: jest.fn().mockResolvedValue({}) } as any,
    { findAuthorSignedDropIds: jest.fn().mockResolvedValue(new Set()) }
  );
}

describe('DropsMappers: polls still open at the freeze, from the switch-on', () => {
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of NAMES) original[name] = process.env[name];
    process.env.WAVES_FREEZE_AT = String(FREEZE);
    process.env.WAVES_SWITCH_ON_AT = String(FREEZE + 86_400_000);
    stubWavesScope({ staying: ['staying-wave'] });
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
  afterEach(() => {
    jest.restoreAllMocks();
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it("shows a moved wave's poll closed at the freeze, and a staying wave's as it is", async () => {
    const [moved, staying] = await createMapper().convertToDropsWithoutWaves(
      DROPS,
      { authenticationContext: AuthenticationContext.notAuthenticated() }
    );
    expect(moved.poll).toMatchObject({ closing_time: FREEZE, is_open: false });
    expect(staying.poll).toMatchObject({ is_open: true });
    expect(staying.poll?.closing_time).toBeGreaterThan(Date.now());
  });

  it('shows every poll as stored before the switch-on', async () => {
    process.env.WAVES_SWITCH_ON_AT = String(Date.now() + 86_400_000);
    const drops = await createMapper().convertToDropsWithoutWaves(DROPS, {
      authenticationContext: AuthenticationContext.notAuthenticated()
    });
    for (const drop of drops) {
      expect(drop.poll).toMatchObject({ is_open: true });
    }
  });
});
