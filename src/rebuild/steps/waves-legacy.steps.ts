import {
  legacyCompetitionDecisionId,
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { WaveEntity, WaveType } from '@/entities/IWave';
import { RebuildContext } from '@/rebuild/manifest.types';
import { probeProfileId } from '@/rebuild/run/probe-fixture.steps';
import { WAVES_WORLD_IDS } from '@/rebuild/world/waves/world-ids';
import { dbSupplier } from '@/sql-executor';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

/**
 * The waves area's legacy rows for the probe fixture: what 6529.io held
 * at the freeze for the world's two imported waves (the ids the chain
 * world's waves carry as legacy ids), their description drops and two chat
 * drops by the fixture profiles, and the members-only wave's group. Fixed
 * ids and times, so both passes ask about the same rows. Until a rebuilder
 * writes these tables from the chain and the drop archives they are kept
 * through the drop, and the probes over them show the baseline a rebuild
 * must give back.
 */
export const WAVES_LEGACY_IDS = WAVES_WORLD_IDS;

/** Rows written, by table: what the seed's step declares it writes. */
export const WAVES_LEGACY_TABLES = [
  WAVES_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  USER_GROUPS_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE
] as const;

const CREATED_AT = 1_764_000_000_000;

/** The rank wave, whose competition the native fixture writes. */
export function rankWave(): WaveEntity {
  return aWave(
    {
      type: WaveType.RANK,
      created_by: probeProfileId(1),
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      description_drop_id: WAVES_LEGACY_IDS.rankDescription
    },
    {
      id: WAVES_LEGACY_IDS.rankWave,
      name: 'Rebuild check rank wave',
      serial_no: 3
    }
  );
}

export function wavesLegacyRows(): Record<string, Record<string, unknown>[]> {
  const author = probeProfileId(1);
  const group = aUserGroup(
    {
      is_private: true,
      is_direct_message: false,
      visible: true,
      created_by: author
    },
    { id: WAVES_LEGACY_IDS.group, name: 'Rebuild check members' }
  );
  const waves = withWaves([
    aWave(
      {
        created_by: author,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        description_drop_id: WAVES_LEGACY_IDS.publicDescription
      },
      {
        id: WAVES_LEGACY_IDS.publicWave,
        name: 'Rebuild check public wave',
        serial_no: 1
      }
    ),
    aWave(
      {
        created_by: author,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        description_drop_id: WAVES_LEGACY_IDS.membersDescription,
        visibility_group_id: group.id,
        chat_group_id: group.id
      },
      {
        id: WAVES_LEGACY_IDS.membersWave,
        name: 'Rebuild check members wave',
        serial_no: 2
      }
    ),
    rankWave()
  ]).rows;
  const drop = (
    id: string,
    waveId: string,
    serial: number,
    authorId: string,
    content: string,
    type: DropType = DropType.CHAT
  ) => ({
    drop: {
      id,
      serial_no: serial,
      wave_id: waveId,
      author_id: authorId,
      created_at: CREATED_AT + serial * 1000,
      updated_at: null,
      title: null,
      parts_count: 1,
      reply_to_drop_id: null,
      reply_to_part_id: null,
      drop_type: type,
      signature: null,
      hide_link_preview: false
    },
    part: {
      drop_id: id,
      drop_part_id: 1,
      content,
      quoted_drop_id: null,
      quoted_drop_part_id: null,
      wave_id: waveId
    }
  });
  const drops = [
    drop(
      WAVES_LEGACY_IDS.publicDescription,
      WAVES_LEGACY_IDS.publicWave,
      1,
      author,
      'A public wave for the rebuild check'
    ),
    drop(
      WAVES_LEGACY_IDS.membersDescription,
      WAVES_LEGACY_IDS.membersWave,
      2,
      author,
      'A members-only wave for the rebuild check'
    ),
    drop(
      WAVES_LEGACY_IDS.rankDescription,
      WAVES_LEGACY_IDS.rankWave,
      5,
      author,
      'A rank wave for the rebuild check'
    ),
    drop(
      WAVES_LEGACY_IDS.rankWinnerDrop,
      WAVES_LEGACY_IDS.rankWave,
      6,
      probeProfileId(2),
      'The rank wave Main Stage winner',
      DropType.WINNER
    ),
    drop(
      WAVES_LEGACY_IDS.firstDrop,
      WAVES_LEGACY_IDS.publicWave,
      3,
      author,
      'A chat drop from before the switch'
    ),
    drop(
      WAVES_LEGACY_IDS.secondDrop,
      WAVES_LEGACY_IDS.publicWave,
      4,
      probeProfileId(2),
      'A reply-free second drop'
    )
  ];
  return {
    // Without is_pure_profile_group, which the schema computes.
    [USER_GROUPS_TABLE]: withUserGroups([group]).rows,
    [WAVES_TABLE]: waves,
    [DROPS_TABLE]: drops.map((d) => d.drop),
    [DROPS_PARTS_TABLE]: drops.map((d) => d.part)
  };
}

/** When the rank wave's one decision ran (made up, a day after the waves). */
const DECISION_AT = CREATED_AT + 86_400_000;

/**
 * The rank wave as a Main Stage with one decided winner, as the native
 * competition runtime holds it after a decision: the MAIN_STAGE capability,
 * a completed decision, the winner drop's entry (WINNER, rank 1) and the
 * decision's winner row. The mint area maps a card to this drop
 * (meme_card_drop_mappings); written after the rank wave's competition.
 */
export function mainStageWinnerRows(): Record<
  string,
  Record<string, unknown>[]
> {
  const competitionId = legacyCompetitionId(WAVES_LEGACY_IDS.rankWave);
  const decisionId = legacyCompetitionDecisionId(competitionId, DECISION_AT);
  const entryId = legacyCompetitionEntryId(
    competitionId,
    WAVES_LEGACY_IDS.rankWinnerDrop
  );
  return {
    [COMPETITION_CAPABILITIES_TABLE]: [
      {
        competition_id: competitionId,
        wave_id: WAVES_LEGACY_IDS.rankWave,
        capability: 'MAIN_STAGE',
        assigned_at: CREATED_AT
      }
    ],
    [COMPETITION_DECISIONS_TABLE]: [
      {
        id: decisionId,
        competition_id: competitionId,
        scheduled_at: DECISION_AT,
        decided_at: DECISION_AT,
        status: 'COMPLETED',
        execution_key: `native:${competitionId}:${DECISION_AT}`,
        created_at: DECISION_AT
      }
    ],
    [COMPETITION_ENTRIES_TABLE]: [
      {
        id: entryId,
        competition_id: competitionId,
        wave_id: WAVES_LEGACY_IDS.rankWave,
        drop_id: WAVES_LEGACY_IDS.rankWinnerDrop,
        submitter_id: probeProfileId(2),
        status: 'WINNER',
        config_version: 1,
        submitted_at: CREATED_AT + 6000,
        won_at: DECISION_AT,
        rank: 1,
        decision_id: decisionId
      }
    ],
    [COMPETITION_DECISION_WINNERS_TABLE]: [
      {
        competition_id: competitionId,
        entry_id: entryId,
        decision_id: decisionId,
        rank: 1,
        final_rating: 0,
        created_at: DECISION_AT
      }
    ]
  };
}

async function insertRows(
  tables: Record<string, Record<string, unknown>[]>
): Promise<void> {
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      const params = Object.fromEntries(
        columns.map((column) => [column, cell(row[column])])
      );
      // Quoted: `rank` is a reserved word in MySQL 8.
      await dbSupplier().execute(
        `insert into ${table} (${columns.map((column) => `\`${column}\``).join(', ')})
         values (${columns.map((column) => `:${column}`).join(', ')})`,
        params
      );
    }
  }
}

function cell(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date || value === null) return value;
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

/**
 * Seed: the legacy rows, through plain inserts with fixed values; the rank
 * wave's competition through the native competition fixture; then its Main
 * Stage winner.
 */
export async function seedWavesLegacy(_ctx: RebuildContext): Promise<void> {
  await insertRows(wavesLegacyRows());
  // The rank wave's competition, as the native competition code holds it.
  await seedNativeOriginalPrimaryFixture(rankWave());
  await insertRows(mainStageWinnerRows());
}
