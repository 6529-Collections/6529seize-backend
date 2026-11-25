import 'reflect-metadata';
import { legacyCompetitionId } from '@/competitions/competition-id';
import {
  DROP_MENTIONED_WAVES_TABLE,
  DROP_POLL_OPTIONS_TABLE,
  DROP_POLLS_TABLE,
  DROPS_TABLE,
  WAVE_CURATIONS_TABLE
} from '@/constants';
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

// Dates read and written in UTC, as runExport sets it.
process.env.TZ = 'UTC';

const PUBLIC_ID = 'a0000000-0000-4000-8000-000000000001';
const MEMBERS_ID = 'a0000000-0000-4000-8000-000000000003';
/** The waves freeze the reads are at: every fixture is older but those after it. */
const FREEZE_MS = Date.UTC(2100, 0, 1);

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
const PUBLIC_GROUP = aUserGroup(
  { is_private: false, is_direct_message: false, visible: true },
  { id: 'public-00000000000000000000001', name: 'Public' }
);
// A public wave whose admin group is hidden: it stays on 6529.io.
const HIDDEN_ADMIN_WAVE = aWave(
  { admin_group_id: HIDDEN_GROUP.id },
  {
    id: 'a0000000-0000-4000-8000-000000000007',
    name: 'Hidden admin',
    serial_no: 7
  }
);
// The signed records wave: it stays by its id, though its post group is an
// ordinary, public one.
const RECORDS_WAVE = aWave(
  { chat_group_id: PUBLIC_GROUP.id },
  { id: 'a0000000-0000-4000-8000-000000000008', name: 'Records', serial_no: 8 }
);
// A public group made after the freeze, and a direct message's group.
const LATE_GROUP = aUserGroup(
  {
    is_private: false,
    is_direct_message: false,
    visible: true,
    created_at: new Date(FREEZE_MS + 60_000)
  },
  { id: 'late-0000000000000000000000001', name: 'Late' }
);
const DM_GROUP = aUserGroup(
  { is_private: false, is_direct_message: true, visible: true },
  { id: 'dm-000000000000000000000000001', name: 'DM group' }
);
// One wave for each of the rule's other reasons.
const LATE_WAVE = aWave(
  { created_at: FREEZE_MS + 1 },
  { id: 'a0000000-0000-4000-8000-0000000000a1', name: 'Late', serial_no: 9 }
);
const LATE_GROUP_WAVE = aWave(
  { admin_group_id: LATE_GROUP.id },
  {
    id: 'a0000000-0000-4000-8000-0000000000a2',
    name: 'Late group',
    serial_no: 10
  }
);
const CHAT_OFF_WAVE = aWave(
  { chat_enabled: false },
  {
    id: 'a0000000-0000-4000-8000-0000000000a3',
    name: 'Chat off',
    serial_no: 11
  }
);
const GONE_GROUP_WAVE = aWave(
  { chat_group_id: 'gone-0000000000000000000000001' },
  {
    id: 'a0000000-0000-4000-8000-0000000000a4',
    name: 'Gone group',
    serial_no: 12
  }
);
const ORPHAN_WAVE = aWave(
  { parent_wave_id: 'a0000000-0000-4000-8000-0000000000ff' },
  { id: 'a0000000-0000-4000-8000-0000000000a5', name: 'Orphan', serial_no: 13 }
);
const DM_GROUP_WAVE = aWave(
  { admin_group_id: DM_GROUP.id },
  {
    id: 'a0000000-0000-4000-8000-0000000000a6',
    name: 'DM group',
    serial_no: 14
  }
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
      DECISION_WAVE,
      HIDDEN_ADMIN_WAVE,
      RECORDS_WAVE,
      LATE_WAVE,
      LATE_GROUP_WAVE,
      CHAT_OFF_WAVE,
      GONE_GROUP_WAVE,
      ORPHAN_WAVE,
      DM_GROUP_WAVE
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
    // A drop that mentions a moving wave (the API nests that wave in it,
    // mentioned_waves[].wave), and a closed poll on one.
    {
      table: DROP_MENTIONED_WAVES_TABLE,
      rows: [
        {
          drop_id: 'members-drop-4',
          wave_name_in_content: 'Public',
          wave_id: PUBLIC_ID
        }
      ]
    },
    {
      table: DROP_POLLS_TABLE,
      rows: [
        {
          id: 'made-up-poll',
          wave_id: PUBLIC_ID,
          drop_id: descriptionDrop(PUBLIC_ID),
          closing_time: 1_500,
          multichoice: false,
          anonymous: false,
          only_droppers_can_respond: false
        }
      ]
    },
    {
      table: DROP_POLL_OPTIONS_TABLE,
      rows: [1, 2].map((option) => ({
        poll_id: 'made-up-poll',
        option_no: option,
        wave_id: PUBLIC_ID,
        drop_id: descriptionDrop(PUBLIC_ID),
        option_string: `Option ${option}`
      }))
    },
    withUserGroups([
      PRIVATE_GROUP,
      HIDDEN_GROUP,
      PUBLIC_GROUP,
      LATE_GROUP,
      DM_GROUP
    ]),
    {
      table: WAVE_CURATIONS_TABLE,
      rows: [
        {
          id: 'curation-public',
          name: 'Picks',
          wave_id: PUBLIC_WAVE.id,
          community_group_id: PUBLIC_GROUP.id,
          created_at: 1,
          updated_at: 1,
          priority_order: null
        },
        {
          id: 'curation-members',
          name: 'Picks',
          wave_id: MEMBERS_WAVE.id,
          community_group_id: PRIVATE_GROUP.id,
          created_at: 1,
          updated_at: 1,
          priority_order: null
        }
      ]
    },
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

    it('reads waves with why they stay, wave REP, groups and decisions', async () => {
      const waves = await source.listWaves({
        recordsWaveId: RECORDS_WAVE.id,
        freezeMs: FREEZE_MS
      });
      // The shared rule's reasons (src/waves-scope), by its SQL form.
      expect(waves.map((wave) => [wave.id, wave.stay_reasons])).toEqual([
        [PUBLIC_WAVE.id, []],
        [SUBWAVE.id, []],
        [MEMBERS_WAVE.id, ['members_only', 'hidden_or_private_group']],
        [DM_WAVE.id, ['direct_message']],
        // Under a direct message: it stays as its parent does.
        [UNDER_DM.id, ['parent_stays']],
        [DECISION_WAVE.id, []],
        [HIDDEN_ADMIN_WAVE.id, ['hidden_or_private_group']],
        [RECORDS_WAVE.id, ['records_wave']],
        [LATE_WAVE.id, ['created_after_freeze']],
        [LATE_GROUP_WAVE.id, ['group_created_after_freeze']],
        [CHAT_OFF_WAVE.id, ['chat_disabled_no_admin_group']],
        // A group id with no row stays, and so does a direct message's group.
        [GONE_GROUP_WAVE.id, ['hidden_or_private_group']],
        // A parent with no row.
        [ORPHAN_WAVE.id, ['parent_stays']],
        [DM_GROUP_WAVE.id, ['hidden_or_private_group']]
      ]);
      // A rehearsal has no freeze: nothing is made after it.
      const rehearsal = await source.listWaves({
        recordsWaveId: RECORDS_WAVE.id,
        freezeMs: null
      });
      expect(
        rehearsal
          .filter((wave) =>
            [LATE_WAVE.id, LATE_GROUP_WAVE.id].includes(wave.id)
          )
          .map((wave) => wave.stay_reasons)
      ).toEqual([[], []]);
      expect(waves.find((wave) => wave.id === MEMBERS_WAVE.id)).toMatchObject({
        visibility_group_id: PRIVATE_GROUP.id,
        chat_group_id: PRIVATE_GROUP.id
      });
      // A wave's curations: each one's id, wave and group.
      expect(await source.waveCurations([PUBLIC_WAVE.id, SUBWAVE.id])).toEqual([
        {
          id: 'curation-public',
          wave_id: PUBLIC_WAVE.id,
          group_id: PUBLIC_GROUP.id
        }
      ]);

      const rep = await source.waveRep([PUBLIC_WAVE.id, MEMBERS_WAVE.id]);
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
        DM_GROUP.id,
        LATE_GROUP.id,
        'no-such-group'
      ]);
      expect(Object.keys(groups).sort()).toEqual(
        [HIDDEN_GROUP.id, PRIVATE_GROUP.id, DM_GROUP.id, LATE_GROUP.id].sort()
      );
      // The rule's fields: a direct message's group says so, and created_at
      // is in ms.
      expect(groups[DM_GROUP.id]).toMatchObject({ is_direct_message: true });
      // The API's stays_on_site is left out of every object the export
      // reads, at any depth.
      expect(JSON.stringify(groups)).not.toContain('stays_on_site');
      expect(groups[PRIVATE_GROUP.id].is_direct_message).toBeUndefined();
      expect(groups[LATE_GROUP.id].created_at).toBe(FREEZE_MS + 60_000);
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
      expect(JSON.stringify(competition)).not.toContain('stays_on_site');
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
      const members = (
        await source.listWaves({
          recordsWaveId: RECORDS_WAVE.id,
          freezeMs: FREEZE_MS
        })
      ).find((wave) => wave.id === MEMBERS_WAVE.id)!;
      const configuration = await source.waveConfiguration(members, [
        PRIVATE_GROUP.id
      ]);
      // Its description drop carries its wave: nested, and left out too.
      expect(configuration).toHaveProperty('description_drop.wave.id');
      expect(JSON.stringify(configuration)).not.toContain('stays_on_site');
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
      // A mentioned wave is nested in its drop, without stays_on_site.
      expect(drops['members-drop-4'].mentioned_waves).toMatchObject([
        { wave_id: PUBLIC_ID, wave: { id: PUBLIC_ID } }
      ]);
      expect(JSON.stringify(drops)).not.toContain('stays_on_site');
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
      // A closed poll's drop, with its poll, without stays_on_site.
      const polls = await source.wavePolls(
        PUBLIC_WAVE.id,
        'CLOSED',
        Date.now()
      );
      expect(polls.map((drop) => drop.id)).toEqual([
        descriptionDrop(PUBLIC_ID)
      ]);
      expect(polls[0]).toHaveProperty('poll.id', 'made-up-poll');
      expect(JSON.stringify(polls)).not.toContain('stays_on_site');
      expect(
        await source.wavePolls(PUBLIC_WAVE.id, 'OPEN', Date.now())
      ).toEqual([]);
    });
  }
);
