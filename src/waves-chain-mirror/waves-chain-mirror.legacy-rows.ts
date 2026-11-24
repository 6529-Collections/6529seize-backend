import {
  legacyCompetitionEntryId,
  legacyCompetitionId
} from '@/competitions/competition-id';
import {
  CompetitionCapability,
  CompetitionEntity,
  CompetitionEntryStatus,
  CompetitionExecutionMode,
  CompetitionLifecycle,
  CompetitionType
} from '@/entities/ICompetition';
import { WAVES_CHAIN_INDEX_STATE_TABLE } from '@/constants';
import { WAVES_CHAIN_INDEX_STATE_NAME } from '@/waves-chain-index/waves-chain-index.db';
import { resultDecisionId } from './waves-chain-mirror.ids';
import { PlanCounter, timeOf } from './waves-chain-mirror.plan-support';
import { ChainDecisionState } from './waves-chain-mirror.types';

/**
 * A rebuild's rows of the imported objects 6529.io has no row of (its
 * tables dropped for the rebuild): what 6529.io held of them at the
 * freeze, from the chain's records, their documents and their legacy ids.
 * The live mirror never writes these: 6529.io's own rows are there.
 *
 * - A wave: its row as 6529.io's create makes one from the wave document
 *   and the chain's policy (waves-chain-mirror.objects.ts). Its competition
 *   columns are its primary competition's (6529.io reads them from there).
 * - A decision: its competitions row from the decision document, 6529.io's
 *   own competition object (importedCompetitionRecord), with its config
 *   version and capabilities, and its outcomes unless it is a wave's
 *   primary.
 * - Its entries, results and winners (importedDecisionRows).
 *
 * What the chain can't give is listed by mirrorPlannedRows.
 */

/**
 * What the rebuild check's import of the drop archives (the import-files
 * reader's step, run before the mirror's rebuild) gives the mirror: each
 * imported wave's description drop id (its legacy id to the drop id), the
 * drop it writes under its original id from the export.
 */
export interface DropArchivesImport {
  readonly descriptionDropIds: ReadonlyMap<string, string>;
}

/** Until when the planned rows stay planned. */
export const PLANNED_UNTIL = '2026-12-04';

/**
 * The rows and columns a rebuild can't make from the chain, by table: the
 * rebuild check keeps them out of its comparison until PLANNED_UNTIL.
 * `where` picks the rows, as seeded (SQL on the table's rows, which may
 * read the chain index's and the mirror's tables); `rows` says which they
 * are. `columns` null: the whole rows. `change` names the scheduled work
 * that brings the rows' source, or says that none is scheduled yet.
 */
export interface PlannedRows {
  readonly table: string;
  readonly where: string;
  readonly rows: string;
  /** The columns that may differ; null: the whole rows. */
  readonly columns: readonly string[] | null;
  readonly reason: string;
  readonly change: string;
  readonly until: string;
}

/**
 * 6529.io's own rows the chain imported, by the chain index's legacy ids
 * (never "not made on the chain": 6529.io has rows the chain never had,
 * such as direct-message waves and their groups).
 */
const IMPORTED_WAVES = `select legacy_id from chain_waves where origin = 'legacy'`;
const IMPORTED_DECISIONS = `select legacy_id from chain_decisions where origin = 'legacy'`;
const IMPORTED_ENTRY_DROPS = `select legacy_id from chain_entries where origin = 'legacy'`;
/**
 * The 6529.io id of an imported group the chain never replaced (version
 * 1), as the mirror matched it: a rebuild visits every such group and
 * keeps its match in its own records. A replaced group's row is the
 * mirror's, written from the chain, and stays compared.
 */
const IMPORTED_GROUPS = `select m.group_id from waves_chain_mirror_groups m join chain_groups g on g.group_id = m.chain_group_id where g.origin = 'legacy' and g.version <= 1 and m.group_id <> ''`;
const MIRROR_GROUP_LISTS = `select include_list_id from waves_chain_mirror_groups where include_list_id is not null union select exclude_list_id from waves_chain_mirror_groups where exclude_list_id is not null`;
/** 6529.io's own executions of imported decisions (not the chain's). */
const IMPORTED_EXECUTIONS = `competition_id in (${IMPORTED_DECISIONS}) and (execution_key is null or execution_key not like 'chain:%')`;

const NOT_SCHEDULED = 'No change is scheduled yet.';
const READER_STEP =
  "The import-files reader's step, run by the rebuild check before the mirror's rebuild (built; to be wired into the rebuild check).";

/**
 * The waves import's start (ms), as the chain index keeps it
 * (waves_chain_index_state.import_started_at, startMs of the chain's
 * /v1/waves/import answer): the switch the planned rows' history is
 * before. Null until an index run has read the import complete; a
 * comparison with null selects no row, so until then the history entries
 * excuse nothing and those rows show as differences.
 */
export const IMPORT_STARTED_AT_SQL = `(select import_started_at from ${WAVES_CHAIN_INDEX_STATE_TABLE} where name = '${WAVES_CHAIN_INDEX_STATE_NAME}')`;

/**
 * The planned rows, given the switch: 6529.io's history is what happened
 * before it. `switchAt` is a time (ms), or 'chain-index': the start the
 * chain index keeps (IMPORT_STARTED_AT_SQL), read with the where (the
 * rebuild check's choice: its manifest is read before any run input
 * exists). No other SQL reaches a where.
 */
export function mirrorPlannedRows(input: {
  readonly switchAt: number | 'chain-index';
}): readonly PlannedRows[] {
  let switchAt: string;
  let beforeSwitch: string;
  if (typeof input.switchAt === 'number') {
    const at = Math.trunc(input.switchAt);
    if (!Number.isSafeInteger(at) || at <= 0) {
      throw new Error(`The switch time ${input.switchAt} is not a time`);
    }
    switchAt = String(at);
    beforeSwitch = `the switch: the waves import's start (startMs, ${at})`;
  } else if (input.switchAt === 'chain-index') {
    switchAt = IMPORT_STARTED_AT_SQL;
    beforeSwitch =
      "the switch: the waves import's start, as the chain index keeps it (none before an index run read the import complete)";
  } else {
    throw new Error(`The switch ${String(input.switchAt)} is no time`);
  }
  const planned: Omit<PlannedRows, 'until'>[] = [
    {
      table: 'waves',
      where: `id in (${IMPORTED_WAVES})`,
      rows: 'imported waves',
      columns: ['description_drop_id'],
      reason:
        "the description drop is the import-files reader's (from the drop archives): the mirror sets it from the wave document's description_drop_id when the import carries it (once the reader's step ran, only if that drop is in the wave), else from the reader's step's mapping (DropArchivesImport) when the rebuild runs that step first, and writes '' without either; a rebuilt database can't serve the waves API for those imported waves until the reader's step runs (6529.io's wave reads need the description drop)",
      change: READER_STEP
    },
    {
      table: 'waves',
      where: `id in (${IMPORTED_WAVES})`,
      rows: 'imported waves',
      columns: [
        'updated_at',
        'chat_slow_mode_cooldown_ms',
        'hub_participation_config',
        'hub_voting_config'
      ],
      reason:
        "the wave document doesn't carry them (6529.io's last edit, slow mode, and the hub's participation and voting settings): they are written as 6529.io's create makes them for a new wave",
      change: NOT_SCHEDULED
    },
    {
      table: 'waves',
      where: 'true',
      rows: 'all',
      columns: ['serial_no'],
      reason: "auto-increment: 6529.io's numbering, not the chain's",
      change: NOT_SCHEDULED
    },
    {
      table: 'drops',
      where: `id in (select description_drop_id from waves where id in (${IMPORTED_WAVES})) or id in (${IMPORTED_ENTRY_DROPS})`,
      rows: "imported waves' description drops and imported entries' drops",
      columns: null,
      reason: "the import-files reader's, from the drop archives",
      change: READER_STEP
    },
    {
      table: 'drops_parts',
      where: `drop_id in (select description_drop_id from waves where id in (${IMPORTED_WAVES})) or drop_id in (${IMPORTED_ENTRY_DROPS})`,
      rows: "imported waves' description drops and imported entries' drops",
      columns: null,
      reason: "the import-files reader's, from the drop archives",
      change: READER_STEP
    },
    {
      table: 'waves_metadatas',
      where: `wave_id in (${IMPORTED_WAVES})`,
      rows: 'imported waves',
      columns: null,
      reason: "the wave document doesn't carry 6529.io's wave metadata",
      change: NOT_SCHEDULED
    },
    {
      table: 'community_groups',
      where: `id in (${IMPORTED_GROUPS})`,
      rows: 'imported groups',
      columns: null,
      reason:
        "6529.io's id is the slug of the group's name and its short id, and the name is only in the group's definition document, addressed by commitment and not served by CID: the chain can't name the row (kept through the drop, matched by legacy id as the live mirror matches it)",
      change: NOT_SCHEDULED
    },
    {
      table: 'profile_groups',
      where: `profile_group_id in (select profile_group_id from community_groups where id in (${IMPORTED_GROUPS}) union select excluded_profile_group_id from community_groups where id in (${IMPORTED_GROUPS})) and profile_group_id not in (${MIRROR_GROUP_LISTS})`,
      rows: 'the lists of imported groups the chain never replaced (version 1)',
      columns: null,
      reason: "6529.io's lists of a group the mirror can't name (as above)",
      change: NOT_SCHEDULED
    },
    {
      table: 'competitions',
      where: `id in (${IMPORTED_DECISIONS})`,
      rows: 'imported decisions',
      columns: ['updated_at', 'cancelled_at'],
      reason: "the decision document doesn't carry them",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_config_versions',
      where: `competition_id in (${IMPORTED_DECISIONS}) and version = (select c.config_version from competitions c where c.id = competition_config_versions.competition_id)`,
      rows: 'imported decisions',
      columns: ['config', 'created_by', 'created_at'],
      reason:
        'the decision document carries only the current configuration: the row of its current version is written with it, the creator and time of no version are known',
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_config_versions',
      where: `competition_id in (${IMPORTED_DECISIONS}) and version < (select c.config_version from competitions c where c.id = competition_config_versions.competition_id)`,
      rows: "imported decisions' versions before the current one",
      columns: null,
      reason: 'the decision document carries only the current version',
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_lifecycle_events',
      where: `competition_id in (${IMPORTED_DECISIONS}) and created_at < ${switchAt}`,
      rows: `imported decisions' lifecycle events before ${beforeSwitch}`,
      columns: null,
      reason:
        "6529.io's history of an imported decision's lifecycle isn't on the chain (the moves the chain makes after it are written)",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_pauses',
      where: `competition_id in (${IMPORTED_DECISIONS})`,
      rows: 'imported decisions',
      columns: null,
      reason:
        "the chain's imported pauses aren't written as 6529.io's pause rows",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_capabilities',
      where: `competition_id in (${IMPORTED_DECISIONS})`,
      rows: 'imported decisions',
      columns: ['assigned_by', 'legacy_source_wave_id', 'assigned_at'],
      reason:
        "the decision document lists the capabilities, not who assigned them or when (assigned_at is written as the competition's created_at)",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_outcomes',
      where: `competition_id in (select id from competitions where id in (${IMPORTED_DECISIONS}) and legacy_wave_id is not null)`,
      rows: "imported waves' primary decisions",
      columns: null,
      reason:
        "written by 6529.io's retired wave-to-competition migration (its ids and legacy_index), which the document doesn't give",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_outcome_distribution_items',
      where: `competition_id in (select id from competitions where id in (${IMPORTED_DECISIONS}) and legacy_wave_id is not null)`,
      rows: "imported waves' primary decisions",
      columns: null,
      reason: 'as competition_outcomes',
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_outcomes',
      where: `competition_id in (select id from competitions where id in (${IMPORTED_DECISIONS}) and legacy_wave_id is null)`,
      rows: 'other imported decisions',
      columns: ['created_at'],
      reason:
        "the time 6529.io wrote the outcomes isn't on the chain (written as the competition's created_at)",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_entries',
      where: `competition_id in (select id from competitions where id in (${IMPORTED_DECISIONS}) and legacy_wave_id is null) and drop_id in (${IMPORTED_ENTRY_DROPS})`,
      rows: "entries of imported decisions that aren't a wave's primary",
      columns: null,
      reason:
        "6529.io gave them a random id (randomUUID), which the chain doesn't carry",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_entries',
      where: `competition_id in (${IMPORTED_DECISIONS}) and drop_id in (${IMPORTED_ENTRY_DROPS})`,
      rows: 'imported entries',
      columns: ['config_version', 'withdrawn_at', 'disqualified_at'],
      reason:
        "the chain's entry doesn't carry the configuration version it entered under or when it was withdrawn or disqualified (config_version is written as the competition's)",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_decisions',
      where: `${IMPORTED_EXECUTIONS} and status = 'COMPLETED'`,
      rows: "imported results (6529.io's completed executions)",
      columns: ['decided_at', 'created_at'],
      reason:
        'the chain keeps the result time only (both are written as the result time)',
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_decisions',
      where: `${IMPORTED_EXECUTIONS} and status <> 'COMPLETED'`,
      rows: "6529.io's cancelled or pending executions of imported decisions",
      columns: null,
      reason:
        "the import takes only the results 6529.io completed: an execution it cancelled (a skipped result) or left pending isn't on the chain",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_decision_winners',
      where: `decision_id in (select id from competition_decisions where ${IMPORTED_EXECUTIONS})`,
      rows: 'imported results',
      columns: ['created_at'],
      reason: 'the chain keeps the result time only (written as it)',
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_winner_votes',
      where: `decision_id in (select id from competition_decisions where ${IMPORTED_EXECUTIONS})`,
      rows: 'imported results',
      columns: null,
      reason:
        "6529.io's weighting of each voter at its own decision: the chain keeps the winner's score only",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_outcome_awards',
      where: `decision_id in (select id from competition_decisions where ${IMPORTED_EXECUTIONS})`,
      rows: 'imported results',
      columns: null,
      reason: "6529.io's runtime's awards aren't derived from the chain",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_vote_history',
      where: `competition_id in (${IMPORTED_DECISIONS}) and occurred_at < ${switchAt}`,
      rows: `votes before ${beforeSwitch}`,
      columns: null,
      reason:
        "the chain keeps each entry's total over time, not each vote 6529.io recorded",
      change: NOT_SCHEDULED
    },
    {
      table: 'competition_score_history',
      where: `competition_id in (${IMPORTED_DECISIONS}) and occurred_at < ${switchAt}`,
      rows: `scores before ${beforeSwitch}`,
      columns: null,
      reason: 'as competition_vote_history',
      change: NOT_SCHEDULED
    }
  ];
  return planned.map((entry) => ({ ...entry, until: PLANNED_UNTIL }));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
    ? null
    : Number(v);
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' ? v : null;
const ofEnum = <T extends string>(
  values: Record<string, T>,
  v: unknown
): T | null => (Object.values(values).includes(v as T) ? (v as T) : null);

/** An imported decision's document: 6529.io's competition object. */
export interface ImportedDecisionDoc {
  readonly id: string;
  readonly waveId: string;
  readonly type: CompetitionType;
  readonly lifecycle: CompetitionLifecycle;
  readonly title: string;
  readonly description: string | null;
  readonly configVersion: number;
  readonly participation: Record<string, unknown>;
  readonly voting: Record<string, unknown>;
  readonly decisions: Record<string, unknown>;
  readonly winners: Record<string, unknown>;
  readonly outcomes: Record<string, unknown>[];
  readonly capabilities: CompetitionCapability[];
  readonly presentation: Record<string, unknown>[];
  readonly createdAt: number;
  readonly publishedAt: number | null;
  readonly endedAt: number | null;
  readonly archivedAt: number | null;
}

/** An imported decision's document, read; a reason when it can't be. */
export function parseImportedDecisionDoc(
  bytes: Uint8Array
): { ok: true; doc: ImportedDecisionDoc } | { ok: false; reason: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { ok: false, reason: 'decision_document_not_json' };
  }
  if (!isObject(doc) || doc.kind !== 'decision' || doc.v !== 1) {
    return { ok: false, reason: 'decision_document_not_a_decision' };
  }
  const type = ofEnum(CompetitionType, doc.type);
  const lifecycle = ofEnum(CompetitionLifecycle, doc.lifecycle);
  const createdAt = timeOf(doc.created_at);
  if (
    typeof doc.id !== 'string' ||
    typeof doc.wave_id !== 'string' ||
    !type ||
    !lifecycle ||
    typeof doc.title !== 'string' ||
    createdAt === null ||
    !isObject(doc.participation) ||
    !isObject(doc.voting) ||
    !isObject(doc.decisions) ||
    !isObject(doc.winners)
  ) {
    return { ok: false, reason: 'decision_document_invalid' };
  }
  const capabilities = (
    Array.isArray(doc.capabilities) ? doc.capabilities : []
  ).flatMap((c) => {
    const capability = ofEnum(CompetitionCapability, c);
    return capability ? [capability] : [];
  });
  return {
    ok: true,
    doc: {
      id: doc.id.toLowerCase(),
      waveId: doc.wave_id.toLowerCase(),
      type,
      lifecycle,
      title: doc.title,
      description: strOrNull(doc.description),
      configVersion: Math.max(1, Number(doc.config_version) || 1),
      participation: doc.participation,
      voting: doc.voting,
      decisions: doc.decisions,
      winners: doc.winners,
      outcomes: (Array.isArray(doc.outcome_config)
        ? doc.outcome_config
        : []
      ).filter(isObject),
      capabilities,
      presentation: (Array.isArray(doc.presentation)
        ? doc.presentation
        : []
      ).filter(isObject),
      createdAt,
      publishedAt: timeOf(doc.published_at),
      endedAt: timeOf(doc.ended_at),
      archivedAt: timeOf(doc.archived_at)
    }
  };
}

/** Whether a decision is its wave's primary (6529.io's legacy_wave_id). */
export function isPrimaryOf(doc: Pick<ImportedDecisionDoc, 'id' | 'waveId'>) {
  return doc.id === legacyCompetitionId(doc.waveId);
}

/** A creditor as 6529.io stores it: its profile id. */
function creditorOf(value: unknown): string | null {
  if (isObject(value)) return strOrNull(value.id);
  return strOrNull(value);
}

/**
 * The competitions row of an imported decision, as 6529.io held it: its
 * document's configuration, run by 6529.io's runtime (ACTIVE).
 */
export function importedCompetitionRecord(
  doc: ImportedDecisionDoc
): CompetitionEntity {
  const voting = {
    ...doc.voting,
    credit_creditor: creditorOf(doc.voting.credit_creditor)
  };
  return {
    id: doc.id,
    wave_id: doc.waveId,
    legacy_wave_id: isPrimaryOf(doc) ? doc.waveId : null,
    execution_mode: CompetitionExecutionMode.ACTIVE,
    type: doc.type,
    lifecycle: doc.lifecycle,
    title: doc.title,
    description: doc.description,
    presentation_config:
      doc.presentation as CompetitionEntity['presentation_config'],
    participation_config: doc.participation,
    voting_config: voting,
    decision_config: doc.decisions,
    winner_config: doc.winners,
    outcome_config: doc.outcomes,
    config_version: doc.configVersion,
    participation_starts_at: numOrNull(doc.participation.starts_at),
    participation_ends_at: numOrNull(doc.participation.ends_at),
    voting_starts_at: numOrNull(doc.voting.starts_at),
    voting_ends_at: numOrNull(doc.voting.ends_at),
    created_at: doc.createdAt,
    updated_at: doc.createdAt,
    published_at: doc.publishedAt,
    ended_at: doc.endedAt,
    cancelled_at: null,
    archived_at: doc.archivedAt
  } as CompetitionEntity;
}

const ENTRY_STATUS: Record<string, CompetitionEntryStatus> = {
  active: CompetitionEntryStatus.ACTIVE,
  winner: CompetitionEntryStatus.WINNER,
  withdrawn: CompetitionEntryStatus.WITHDRAWN,
  disqualified: CompetitionEntryStatus.DISQUALIFIED
};

export interface ImportedEntryRow {
  readonly id: string;
  readonly competition_id: string;
  readonly wave_id: string;
  readonly drop_id: string;
  readonly submitter_id: string;
  readonly status: CompetitionEntryStatus;
  readonly config_version: number;
  readonly submitted_at: number;
  readonly won_at: number | null;
  readonly rank: number | null;
  readonly decision_id: string | null;
}

export interface ImportedResultRow {
  readonly id: string;
  readonly competition_id: string;
  readonly scheduled_at: number;
  readonly decided_at: number;
  readonly status: 'COMPLETED';
  readonly execution_key: string;
  readonly created_at: number;
}

export interface ImportedWinnerRow {
  readonly competition_id: string;
  readonly entry_id: string;
  readonly decision_id: string;
  readonly rank: number;
  readonly final_rating: number;
  readonly created_at: number;
}

/**
 * An imported decision's entries, results and winners as 6529.io held them:
 * the chain's imported entries (origin legacy) and results (origin legacy,
 * decided). An entry gets 6529.io's id where the decision is its wave's
 * primary (legacyCompetitionEntryId, as 6529.io derives it); elsewhere
 * 6529.io's id was random, and the entry (with its result's winner row)
 * waits as planned. An entry whose author has no profile waits.
 */
export function importedDecisionRows(
  chain: ChainDecisionState,
  competition: {
    readonly id: string;
    readonly waveId: string;
    readonly primary: boolean;
    readonly configVersion: number;
  },
  authors: ReadonlyMap<string, string>,
  counter: PlanCounter
): {
  entries: ImportedEntryRow[];
  results: ImportedResultRow[];
  winners: ImportedWinnerRow[];
} {
  const entries: ImportedEntryRow[] = [];
  const rowIdOf = new Map<string, string>();
  for (const entry of chain.entries) {
    if (entry.origin !== 'legacy' || !entry.legacyId) continue;
    const status = ENTRY_STATUS[entry.status];
    if (!status) {
      counter.wait('imported_entry_status_unknown');
      continue;
    }
    if (!competition.primary) {
      counter.wait('imported_entry_id_planned');
      continue;
    }
    const submitter = authors.get(entry.author.toLowerCase());
    const submittedAt = timeOf(entry.data.createdMs);
    if (!submitter || submittedAt === null) {
      counter.wait(
        submitter
          ? 'imported_entry_without_time'
          : 'imported_entry_author_unmapped'
      );
      continue;
    }
    const id = legacyCompetitionEntryId(competition.id, entry.legacyId);
    rowIdOf.set(entry.entryId.toLowerCase(), id);
    const resultTime = timeOf(entry.data.resultTime);
    const rank = Number(entry.data.rank);
    const won = status === CompetitionEntryStatus.WINNER && resultTime !== null;
    entries.push({
      id,
      competition_id: competition.id,
      wave_id: competition.waveId,
      drop_id: entry.legacyId,
      submitter_id: submitter,
      status,
      config_version: competition.configVersion,
      submitted_at: submittedAt,
      won_at: won ? resultTime : null,
      rank: won && Number.isSafeInteger(rank) && rank > 0 ? rank : null,
      decision_id: won ? resultDecisionId(competition.id, resultTime) : null
    });
  }
  const results: ImportedResultRow[] = [];
  const winners: ImportedWinnerRow[] = [];
  for (const result of chain.results) {
    if (
      result.origin !== 'legacy' ||
      result.stage !== 'final' ||
      result.status !== 'decided'
    ) {
      continue;
    }
    const at = result.resultTime;
    const decisionId = resultDecisionId(competition.id, at);
    results.push({
      id: decisionId,
      competition_id: competition.id,
      scheduled_at: at,
      decided_at: at,
      status: 'COMPLETED',
      execution_key: `native:${competition.id}:${at}`,
      created_at: at
    });
    const list = Array.isArray(result.data.winners) ? result.data.winners : [];
    for (const item of list) {
      const winner = isObject(item) ? item : {};
      const entryId =
        typeof winner.entryId === 'string'
          ? rowIdOf.get(winner.entryId.toLowerCase())
          : undefined;
      const rank = Number(winner.rank);
      if (!entryId) {
        counter.wait('imported_winner_entry_without_row');
        continue;
      }
      if (winner.score === null || winner.score === undefined) {
        counter.wait('imported_winner_without_score');
        continue;
      }
      const rating = Number(winner.score);
      if (!Number.isSafeInteger(rank) || !Number.isSafeInteger(rating)) {
        counter.wait('imported_winner_out_of_range');
        continue;
      }
      winners.push({
        competition_id: competition.id,
        entry_id: entryId,
        decision_id: decisionId,
        rank,
        final_rating: rating,
        created_at: at
      });
    }
  }
  return { entries, results, winners };
}
