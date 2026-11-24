import 'reflect-metadata';
import { legacyCompetitionId } from '@/competitions/competition-id';
import { DROPS_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { RateMatter } from '@/entities/IRating';
import { WaveType } from '@/entities/IWave';
import { describeWithSeed } from '@/tests/_setup/seed';
import { compactDrop } from './waves-export.compact';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { withRatings } from '@/tests/fixtures/rating.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { BackendWavesExportSource } from './waves-export.backend-source';

const AUTHOR = anIdentity(
  {},
  {
    consolidation_key: 'export-author',
    profile_id: 'export-author',
    primary_address: 'export-author-wallet',
    handle: 'export-author'
  }
);

const PUBLIC_ID = 'a0000000-0000-4000-8000-000000000001';
const MEMBERS_ID = 'a0000000-0000-4000-8000-000000000003';

function descriptionDrop(waveId: string): string {
  return `description-${waveId}`;
}

const PUBLIC_WAVE = aWave(
  { description_drop_id: descriptionDrop(PUBLIC_ID) },
  { id: PUBLIC_ID, name: 'Public', serial_no: 1 }
);
const SUBWAVE = aWave(
  { parent_wave_id: PUBLIC_WAVE.id },
  { id: 'a0000000-0000-4000-8000-000000000002', name: 'Sub', serial_no: 2 }
);
const PRIVATE_GROUP = aUserGroup(
  { is_private: true, is_direct_message: false, visible: true },
  { id: 'members-0000000000000000000001', name: 'Members' }
);
const HIDDEN_GROUP = aUserGroup(
  { is_private: false, is_direct_message: false, visible: false },
  { id: 'hidden-00000000000000000000001', name: 'Hidden' }
);
const MEMBERS_WAVE = aWave(
  {
    visibility_group_id: PRIVATE_GROUP.id,
    chat_group_id: PRIVATE_GROUP.id,
    description_drop_id: descriptionDrop(MEMBERS_ID)
  },
  { id: MEMBERS_ID, name: 'Members', serial_no: 3 }
);
const DM_WAVE = aWave(
  { is_direct_message: true },
  { id: 'a0000000-0000-4000-8000-000000000004', name: 'DM', serial_no: 4 }
);
const UNDER_DM = aWave(
  { parent_wave_id: DM_WAVE.id },
  { id: 'a0000000-0000-4000-8000-000000000005', name: 'Under', serial_no: 5 }
);
// A decision's wave: the native decision's type comes from it.
const DECISION_WAVE = aWave(
  { type: WaveType.RANK },
  { id: 'a0000000-0000-4000-8000-000000000006', name: 'Decision', serial_no: 6 }
);

function dropRow(waveId: string, id: string, serial: number) {
  return {
    id,
    serial_no: serial,
    wave_id: waveId,
    author_id: AUTHOR.profile_id!,
    created_at: 1_000 + serial,
    updated_at: null,
    title: null,
    parts_count: 0,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    hide_link_preview: false
  };
}

function waveRep(
  target: string,
  rater: string,
  category: string,
  rating: number
) {
  return {
    rater_profile_id: rater,
    matter_target_id: target,
    matter: RateMatter.WAVE_REP,
    matter_category: category,
    rating,
    last_modified: new Date('2026-11-01T00:00:00Z')
  };
}

describeWithSeed(
  'BackendWavesExportSource',
  [
    withWaves([
      PUBLIC_WAVE,
      SUBWAVE,
      MEMBERS_WAVE,
      DM_WAVE,
      UNDER_DM,
      DECISION_WAVE
    ]),
    withIdentities([AUTHOR]),
    {
      table: DROPS_TABLE,
      rows: [
        dropRow(PUBLIC_WAVE.id, descriptionDrop(PUBLIC_WAVE.id), 1),
        dropRow(MEMBERS_WAVE.id, descriptionDrop(MEMBERS_WAVE.id), 2),
        // A native entry's drop with every table value the API shows
        // differently or not at all.
        {
          ...dropRow(MEMBERS_WAVE.id, 'members-drop-3', 3),
          drop_type: DropType.COMPETITION,
          signature: 'made-up-signature',
          is_additional_action_promised: true,
          hide_link_preview: true,
          collapse_replies: true,
          reply_to_drop_id: 'members-drop-4',
          reply_to_part_id: null
        },
        dropRow(MEMBERS_WAVE.id, 'members-drop-4', 4),
        dropRow(DM_WAVE.id, 'dm-drop-5', 5)
      ]
    },
    withUserGroups([PRIVATE_GROUP, HIDDEN_GROUP]),
    withRatings([
      waveRep(PUBLIC_WAVE.id, 'rater-1', 'Good', 3),
      waveRep(PUBLIC_WAVE.id, 'rater-2', 'Good', 0),
      waveRep(MEMBERS_WAVE.id, 'rater-1', 'Art', -2),
      waveRep(DM_WAVE.id, 'rater-1', 'Art', 1),
      {
        rater_profile_id: 'rater-1',
        matter_target_id: PUBLIC_WAVE.id,
        matter: RateMatter.REP,
        matter_category: 'Good',
        rating: 5,
        last_modified: new Date('2026-11-01T00:00:00Z')
      }
    ])
  ],
  () => {
    const source = new BackendWavesExportSource();

    it('reads waves, wave REP, groups and decisions, never direct messages', async () => {
      const waves = await source.listWaves();
      expect(waves.map((wave) => wave.id)).toEqual([
        PUBLIC_WAVE.id,
        SUBWAVE.id,
        MEMBERS_WAVE.id,
        DECISION_WAVE.id
      ]);
      expect(waves.find((wave) => wave.id === MEMBERS_WAVE.id)).toMatchObject({
        visibility_group_id: PRIVATE_GROUP.id,
        chat_group_id: PRIVATE_GROUP.id
      });

      const rep = await source.waveRep(waves.map((wave) => wave.id));
      expect(rep).toEqual({
        [PUBLIC_WAVE.id]: [
          {
            category: 'Good',
            profile_id: 'rater-1',
            rating: 3,
            last_modified: Date.parse('2026-11-01T00:00:00Z')
          }
        ],
        [MEMBERS_WAVE.id]: [
          {
            category: 'Art',
            profile_id: 'rater-1',
            rating: -2,
            last_modified: Date.parse('2026-11-01T00:00:00Z')
          }
        ]
      });

      const groups = await source.groups([
        PRIVATE_GROUP.id,
        HIDDEN_GROUP.id,
        'no-such-group'
      ]);
      expect(Object.keys(groups).sort()).toEqual(
        [HIDDEN_GROUP.id, PRIVATE_GROUP.id].sort()
      );
      expect(groups[PRIVATE_GROUP.id]).toMatchObject({
        id: PRIVATE_GROUP.id,
        is_private: true
      });
      expect(groups[HIDDEN_GROUP.id]).toMatchObject({ visible: false });
      expect(await source.groupMembers(groups[HIDDEN_GROUP.id])).toEqual([]);

      await seedNativeOriginalPrimaryFixture(DECISION_WAVE);
      const competitionId = legacyCompetitionId(DECISION_WAVE.id);
      expect(
        await source.listCompetitionIds([PUBLIC_WAVE.id, DECISION_WAVE.id])
      ).toEqual([competitionId]);
      const competition = await source.competition(competitionId);
      expect(competition?.competition).toMatchObject({
        id: competitionId,
        wave_id: DECISION_WAVE.id,
        type: 'RANK',
        lifecycle: 'PUBLISHED',
        permissions: { view: true, vote: false, submit: false }
      });
      expect(competition?.details).toEqual({
        entries: [],
        decisions: [],
        outcomes: [],
        pauses: [],
        versions: [],
        voters: []
      });
      expect(await source.competition('no-such-decision')).toBeNull();
    });

    it("reads a members-only wave's configuration and drops", async () => {
      const members = (await source.listWaves()).find(
        (wave) => wave.id === MEMBERS_WAVE.id
      )!;
      const configuration = await source.waveConfiguration(members, [
        PRIVATE_GROUP.id
      ]);
      expect(configuration).toMatchObject({
        id: MEMBERS_WAVE.id,
        visibility: { scope: { group: { id: PRIVATE_GROUP.id } } },
        chat: { scope: { group: { id: PRIVATE_GROUP.id } } }
      });
      // Newest first, two a page, every drop of a members-only wave.
      const pages: string[][] = [];
      for await (const page of source.wavePagesOfDrops(MEMBERS_WAVE.id, 2)) {
        pages.push(page.map((drop) => String(drop.id)));
      }
      expect(pages).toEqual([
        ['members-drop-4', 'members-drop-3'],
        [descriptionDrop(MEMBERS_WAVE.id)]
      ]);
      // Each drop carries the drops table's own values beside the API's.
      const drops: Record<string, Record<string, unknown>> = {};
      for await (const page of source.wavePagesOfDrops(MEMBERS_WAVE.id, 5)) {
        page.forEach((drop) => {
          drops[String(drop.id)] = drop;
        });
      }
      expect(drops['members-drop-3'].drop_type).not.toBe('COMPETITION');
      expect(compactDrop(drops['members-drop-3']).table).toEqual({
        signature: 'made-up-signature',
        is_additional_action_promised: true,
        hide_link_preview: true,
        collapse_replies: true,
        drop_type: 'COMPETITION',
        reply_to_part_id: null
      });
      expect(compactDrop(drops['members-drop-4']).table).toEqual({
        signature: null,
        is_additional_action_promised: null,
        hide_link_preview: false,
        collapse_replies: false,
        drop_type: 'CHAT',
        reply_to_part_id: null
      });
      expect(
        await source.wavePolls(PUBLIC_WAVE.id, 'CLOSED', Date.now())
      ).toEqual([]);
    });
  }
);
