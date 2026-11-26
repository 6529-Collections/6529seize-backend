import {
  CHAIN_CLAIM_BUILDS_TABLE,
  CHAIN_DECISION_LEADERBOARDS_TABLE,
  CHAIN_DECISIONS_TABLE,
  CHAIN_DOCS_TABLE,
  CHAIN_ENTRY_HOLDS_TABLE,
  CHAIN_ENTRIES_TABLE,
  CHAIN_EVENTS_TABLE,
  CHAIN_LEADERBOARD_ROWS_TABLE,
  CHAIN_RESULTS_TABLE,
  CHAIN_VOTES_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITIONS_TABLE,
  WAVES_TABLE,
  WAVES_CHAIN_MIRROR_STATE_TABLE
} from '@/constants';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import { statementChunks } from '@/waves-chain-index/waves-chain-index.db';
import { ChainEvent } from '@/waves-chain-index/waves-chain-index.events';
import {
  applyEntryRemovals,
  applyHistoryWrites,
  applyOutboxEvents,
  applyNativeEntryWrites,
  applyResultWrites,
  applyVoteWrites
} from './waves-chain-mirror.apply';
import { CompetitionCapability } from '@/entities/ICompetition';
import { freezeMemeCollaborationForNativeDecision } from '@/meme-collaborations/meme-collaboration-mint-selection';
import { DocumentCache } from './waves-chain-mirror.docs';
import { importedDecisionRows } from './waves-chain-mirror.legacy-rows';
import { HistoryRead, PlanCounter } from './waves-chain-mirror.plan-support';
import { writerPoolExecutor } from './waves-chain-mirror.writer';
import { DecisionPlan } from './waves-chain-mirror.plan';
import {
  ChainBoardRow,
  ChainDecisionRow,
  ChainDecisionState,
  ChainEntryRow,
  ChainResultRow,
  ChainVoteRow,
  SkippedClaimBuild,
  TargetAward,
  TargetBoardRow,
  TargetCompetition,
  TargetCompetitionState,
  TargetDecision,
  TargetEntry,
  TargetRuntime,
  TargetScorePoint,
  TargetVote,
  TargetWinner,
  TargetWinnerVote
} from './waves-chain-mirror.types';

/**
 * The identity mirror's map of chain principals to 6529.io profile ids
 * (src/identity-chain-mirror). Read by name: that table is the identity
 * mirror's.
 */
export const IDENTITY_CHAIN_PRINCIPALS = 'identity_chain_principals';

/** An entry held back: for good (retryAt null), or a delay until retryAt. */
export interface EntryHold {
  readonly reason: string;
  readonly retryAt: number | null;
  readonly attempts: number;
}

/** What checking an entry made on the chain needs of its competition. */
export interface NativeEntryContext {
  readonly waveId: string;
  readonly waveName: string | null;
  readonly participation: Record<string, unknown>;
  readonly terms: string | null;
  readonly signatureRequired: boolean;
  /** It has the MAIN_STAGE capability. */
  readonly mainStage: boolean;
  /** Which of the asked drop ids already have an entry in it. */
  readonly existing: Set<string>;
}

export interface WavesChainMirrorState {
  readonly network: string | null;
  readonly eventsCursor: string | null;
  readonly indexGeneration: number;
  readonly indexHeight: number | null;
  readonly fullRunning: boolean;
  readonly fullAfter: string | null;
  readonly lastFullAt: number | null;
  /** Decisions that failed: tried again first, next run. */
  readonly retryIds: readonly string[];
  /**
   * Decisions whose VOTE events after a cursor (null: the log's start) are
   * read again when next tried: the event cursor moved past them while
   * they failed, or while they caught up.
   */
  readonly replayFrom: Readonly<Record<string, string | null>>;
  readonly lastError: string | null;
}

export const EMPTY_MIRROR_STATE: WavesChainMirrorState = {
  network: null,
  eventsCursor: null,
  indexGeneration: 0,
  indexHeight: null,
  fullRunning: false,
  fullAfter: null,
  lastFullAt: null,
  retryIds: [],
  replayFrom: {},
  lastError: null
};

/** A logged event as a failed decision's vote history reads it again. */
export type LoggedVote = Pick<
  ChainEvent,
  | 'height'
  | 'seq'
  | 'blockTime'
  | 'kind'
  | 'origin'
  | 'entryId'
  | 'actor'
  | 'data'
>;

/** A place in the event log: an event's height and seq. */
export interface LogPlace {
  readonly height: number;
  readonly seq: number;
}

/** Failed decisions kept for the next run, at most. */
const MAX_RETRY_IDS = 200;

const STATE_NAME = 'waves';
/** The state row a report-only pass keeps its place in. */
const REPORT_STATE_NAME = 'report';
/** About the bytes an id takes in a statement. */
const ID_BYTES = 72;
/** A document is written in parts of this many bytes (hex doubles them). */
const DOC_PART_BYTES = 5_000;

type Conn = ConnectionWrapper<any>;

function opts(connection?: Conn) {
  return connection ? { wrappedConnection: connection } : undefined;
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function json(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function retryIdsOf(value: unknown): string[] {
  try {
    return jsonArray(value ?? '[]').filter(
      (id): id is string => typeof id === 'string'
    );
  } catch {
    return [];
  }
}

function replayFromOf(value: unknown): Record<string, string | null> {
  try {
    const out: Record<string, string | null> = {};
    for (const [id, from] of Object.entries(json(value ?? '{}'))) {
      if (typeof from === 'string' || from === null) out[id] = from;
    }
    return out;
  } catch {
    return {};
  }
}

function jsonArray(value: unknown): unknown[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * How the mirror writes. `live`: as 6529.io's own writes do, with their
 * outbox events (sockets, notifications), claim builds and the effects on
 * other areas' tables. `rebuild`: the rows the mirror owns only (6529.io's
 * competition, wave, drop and group rows it mirrors, and its own tables),
 * so a rebuild from the chain gives the same rows and sends nothing.
 */
export type MirrorMode = 'live' | 'rebuild';

/**
 * A collaboration write that writes nothing: a rebuild leaves an artwork's
 * collaboration, invitations and their notifications to their own area.
 */
export const NO_COLLABORATIONS = {
  onWrite: async (): Promise<number[]> => []
};

/** An outbox that takes nothing: a rebuild sends no events. */
export const NO_OUTBOX = {
  enqueueEvent: async (): Promise<string> => ''
};

/** The chain index's rows, 6529.io's competition rows and the mirror's own. */
export class WavesChainMirrorDb
  extends LazyDbAccessCompatibleService
  implements DocumentCache
{
  constructor(
    supplier: () => SqlExecutor,
    readonly mode: MirrorMode = 'live'
  ) {
    super(supplier);
  }

  // ------------------------------------------------------------ state

  async loadState(): Promise<WavesChainMirrorState> {
    const row = await this.db.oneOrNull<Record<string, unknown>>(
      `select * from ${WAVES_CHAIN_MIRROR_STATE_TABLE} where name = :name`,
      { name: STATE_NAME }
    );
    if (!row) return EMPTY_MIRROR_STATE;
    return {
      network: textOrNull(row.network),
      eventsCursor: textOrNull(row.events_cursor),
      indexGeneration: num(row.index_generation),
      indexHeight: numOrNull(row.index_height),
      fullRunning: Number(row.full_running) === 1 || row.full_running === true,
      fullAfter: textOrNull(row.full_after),
      lastFullAt: numOrNull(row.last_full_at),
      retryIds: retryIdsOf(row.retry_ids),
      replayFrom: replayFromOf(row.replay_from),
      lastError: textOrNull(row.last_error)
    };
  }

  /** Where a report-only pass got to: the last decision it reported. */
  async loadReportPlace(): Promise<string | null> {
    const row = await this.db.oneOrNull<{ full_after: string | null }>(
      `select full_after from ${WAVES_CHAIN_MIRROR_STATE_TABLE}
        where name = :name`,
      { name: REPORT_STATE_NAME }
    );
    return row?.full_after ?? null;
  }

  /** Keeps a report-only pass's place (null: start again). */
  async saveReportPlace(after: string | null, now: number): Promise<void> {
    await this.db.execute(
      `insert into ${WAVES_CHAIN_MIRROR_STATE_TABLE}
         (name, full_after, updated_at)
       values (:name, :after, :now)
       on duplicate key update full_after = :after, updated_at = :now`,
      { name: REPORT_STATE_NAME, after, now }
    );
  }

  /**
   * Releases the entries made on a chain the mirror no longer follows (a
   * relaunched chain: its entries' drop ids are its chain ids): each drop
   * goes through 6529.io's backend delete, as a withdrawn entry's does, so
   * the entry leaves with its votes, board and runtime rows. Returns how
   * many. Run before anything of the new chain is written.
   */
  async releaseChainMadeEntries(): Promise<number> {
    const rows = await this.db.execute<{ id: string; drop_id: string }>(
      `select id, drop_id from ${COMPETITION_ENTRIES_TABLE}
        where drop_id like '0x%' and char_length(drop_id) = 66`
    );
    const done = new Set<string>();
    for (const row of rows) {
      if (done.has(row.drop_id)) continue;
      done.add(row.drop_id);
      await this.inTransaction((connection) =>
        applyEntryRemovals(
          [{ id: row.id, dropId: row.drop_id, status: 'WITHDRAWN' }],
          connection
        )
      );
    }
    return done.size;
  }

  /**
   * Removes the results another network's mirror wrote (a relaunched
   * chain): their decisions, winners, winner votes and awards, and their
   * winners' entries go back to ACTIVE. Results keyed `keepPrefix` stay.
   */
  async removeOtherNetworksResults(keepPrefix: string): Promise<number> {
    return this.inTransaction(async (connection) => {
      const options = { wrappedConnection: connection };
      const rows = await this.db.execute<{
        id: string;
        competition_id: string;
      }>(
        `select id, competition_id from ${COMPETITION_DECISIONS_TABLE}
          where execution_key like 'chain:%'
            and left(execution_key, :n) <> :keep`,
        { n: keepPrefix.length, keep: keepPrefix },
        options
      );
      if (!rows.length) return 0;
      const ids = rows.map((row) => row.id);
      for (const chunk of statementChunks(ids, () => ID_BYTES)) {
        await this.db.execute(
          `update ${COMPETITION_ENTRIES_TABLE}
              set status = 'ACTIVE', won_at = null, \`rank\` = null,
                  decision_id = null
            where status = 'WINNER' and decision_id in (:ids)`,
          { ids: chunk },
          options
        );
        for (const table of [
          COMPETITION_WINNER_VOTES_TABLE,
          COMPETITION_OUTCOME_AWARDS_TABLE,
          COMPETITION_DECISION_WINNERS_TABLE
        ]) {
          await this.db.execute(
            `delete from ${table} where decision_id in (:ids)`,
            { ids: chunk },
            options
          );
        }
        await this.db.execute(
          `delete from ${COMPETITION_DECISIONS_TABLE} where id in (:ids)`,
          { ids: chunk },
          options
        );
      }
      return ids.length;
    });
  }

  async saveState(state: WavesChainMirrorState, now: number): Promise<void> {
    await this.db.execute(
      `insert into ${WAVES_CHAIN_MIRROR_STATE_TABLE}
         (name, network, events_cursor, index_generation, index_height,
          full_running, full_after, last_full_at, retry_ids, replay_from,
          last_error, updated_at)
       values (:name, :network, :eventsCursor, :indexGeneration, :indexHeight,
          :fullRunning, :fullAfter, :lastFullAt, :retryIds, :replayFrom,
          :lastError, :now)
       on duplicate key update
         network = :network, events_cursor = :eventsCursor,
         index_generation = :indexGeneration, index_height = :indexHeight,
         full_running = :fullRunning, full_after = :fullAfter,
         last_full_at = :lastFullAt, retry_ids = :retryIds,
         replay_from = :replayFrom, last_error = :lastError,
         updated_at = :now`,
      {
        name: STATE_NAME,
        ...state,
        fullRunning: state.fullRunning ? 1 : 0,
        retryIds: JSON.stringify(state.retryIds.slice(0, MAX_RETRY_IDS)),
        replayFrom: JSON.stringify(
          Object.fromEntries(
            Object.entries(state.replayFrom).slice(0, MAX_RETRY_IDS)
          )
        ),
        lastError: state.lastError?.slice(0, 2000) ?? null,
        now
      }
    );
  }

  /** Whether the identity mirror's principal map is there to read. */
  async hasPrincipalMap(): Promise<boolean> {
    const row = await this.db.oneOrNull<{ n: number | string }>(
      `select count(*) as n from information_schema.tables
        where table_schema = database() and table_name = :name`,
      { name: IDENTITY_CHAIN_PRINCIPALS }
    );
    return Number(row?.n ?? 0) > 0;
  }

  // ------------------------------------------------------------ the chain

  /** Decision ids after `after`, ascending (a full pass). */
  async decisionIdsAfter(
    after: string | null,
    limit: number
  ): Promise<string[]> {
    const rows = await this.db.execute<{ decision_id: string }>(
      `select decision_id from ${CHAIN_DECISIONS_TABLE}
        where (:after is null or decision_id > :after)
        order by decision_id limit :limit`,
      { after, limit }
    );
    return rows.map((row) => row.decision_id);
  }

  /**
   * Decisions whose scores move with block time alone: counted ones while
   * they are live (as the index's timeDependent reads them).
   */
  async liveDecisionIds(): Promise<string[]> {
    const rows = await this.db.execute<{ decision_id: string }>(
      `select decision_id from ${CHAIN_DECISIONS_TABLE}
        where json_unquote(json_extract(data, '$.counted')) = 'true'
          and (status = 'published' or due = 1
               or json_unquote(json_extract(data, '$.phase')) = 'settling')
        order by decision_id`
    );
    return rows.map((row) => row.decision_id);
  }

  /**
   * Decisions the index wrote again above `height`, or a result of: a
   * status or schedule the event log has no event of. (Entries and votes
   * come with events; a GAP starts a full pass.) Both tables are small.
   */
  async decisionIdsChangedAbove(height: number): Promise<string[]> {
    const rows = await this.db.execute<{ decision_id: string }>(
      `select decision_id from ${CHAIN_DECISIONS_TABLE} where height > :height
       union select decision_id from ${CHAIN_RESULTS_TABLE} where height > :height`,
      { height }
    );
    return rows
      .map((row) => row.decision_id)
      .sort((a, b) => (a < b ? -1 : Number(a > b)));
  }

  /** A decision and everything under it, as the index holds them. */
  async chainDecision(decisionId: string): Promise<ChainDecisionState | null> {
    const decision = await this.db.oneOrNull<Record<string, unknown>>(
      `select decision_id, legacy_id, wave_id, status, kind, next_result_time,
              origin, height, data
         from ${CHAIN_DECISIONS_TABLE} where decision_id = :decisionId`,
      { decisionId }
    );
    if (!decision) return null;
    const entries = await this.db.execute<Record<string, unknown>>(
      `select entry_id, legacy_id, decision_id, author, status,
              cast(total as char) as total, origin, height, data
         from ${CHAIN_ENTRIES_TABLE} where decision_id = :decisionId
        order by entry_id`,
      { decisionId }
    );
    const votes = await this.db.execute<Record<string, unknown>>(
      `select entry_id, voter, cast(value as char) as value, updated_height
         from ${CHAIN_VOTES_TABLE} where decision_id = :decisionId
        order by entry_id, voter`,
      { decisionId }
    );
    const board = await this.db.oneOrNull<{ decision_id: string }>(
      `select decision_id from ${CHAIN_DECISION_LEADERBOARDS_TABLE}
        where decision_id = :decisionId`,
      { decisionId }
    );
    const boardRows = board
      ? await this.db.execute<Record<string, unknown>>(
          `select entry_id, \`rank\`, cast(score as char) as score,
                  cast(total as char) as total, data
             from ${CHAIN_LEADERBOARD_ROWS_TABLE} where decision_id = :decisionId
            order by \`rank\`, entry_id`,
          { decisionId }
        )
      : null;
    const results = await this.db.execute<Record<string, unknown>>(
      `select result_time, status, stage, origin, height, data
         from ${CHAIN_RESULTS_TABLE} where decision_id = :decisionId
        order by result_time`,
      { decisionId }
    );
    return {
      decision: decisionOf(decision),
      entries: entries.map(entryOf),
      votes: votes.map(
        (row): ChainVoteRow => ({
          entryId: String(row.entry_id),
          voter: String(row.voter),
          value: String(row.value),
          updatedHeight: num(row.updated_height)
        })
      ),
      board: boardRows
        ? boardRows.map(
            (row): ChainBoardRow => ({
              entryId: String(row.entry_id),
              rank: num(row.rank),
              score: String(row.score),
              total: String(row.total),
              data: json(row.data)
            })
          )
        : null,
      results: results.map(
        (row): ChainResultRow => ({
          resultTime: num(row.result_time),
          status: String(row.status),
          stage: String(row.stage),
          origin: String(row.origin),
          height: num(row.height),
          data: json(row.data)
        })
      )
    };
  }

  /** The block time of each height the event log has an event at. */
  async blockTimes(heights: readonly number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const chunk of statementChunks(
      Array.from(new Set(heights)),
      () => 24
    )) {
      const rows = await this.db.execute<{ height: unknown; t: unknown }>(
        `select height, min(block_time) as t from ${CHAIN_EVENTS_TABLE}
          where height in (:heights) group by height`,
        { heights: chunk }
      );
      for (const row of rows) out.set(num(row.height), num(row.t));
    }
    return out;
  }

  /**
   * The decision's claim builds the index skipped because the rank-1 entry
   * had no 6529.io drop (waves-chain-index.claims.ts: no drop id, no
   * message). A rebuild writes no claim builds, so it reads none.
   */
  async skippedClaimBuilds(decisionId: string): Promise<SkippedClaimBuild[]> {
    if (this.mode === 'rebuild') return [];
    const rows = await this.db.execute<Record<string, unknown>>(
      `select network, occurrence, height, entry_id
         from ${CHAIN_CLAIM_BUILDS_TABLE}
        where decision_id = :decisionId and status = 'skipped'
          and drop_id is null
        order by occurrence`,
      { decisionId }
    );
    return rows.map((row) => ({
      network: String(row.network),
      occurrence: num(row.occurrence),
      height: num(row.height),
      entryId: String(row.entry_id)
    }));
  }

  /** When each result of a decision went final, by result time. */
  async resultFinalTimes(decisionId: string): Promise<Map<number, number>> {
    const rows = await this.db.execute<{ result_time: unknown; t: unknown }>(
      `select json_extract(data, '$.resultTime') as result_time,
              min(block_time) as t
         from ${CHAIN_EVENTS_TABLE}
        where kind = 'RESULT_FINAL' and decision_id = :decisionId
        group by json_extract(data, '$.resultTime')`,
      { decisionId }
    );
    return new Map(rows.map((row) => [num(row.result_time), num(row.t)]));
  }

  /**
   * A decision's VOTE events after `after` (null: the log's start) up to
   * `upTo`, in log order, at most `limit`. Read by its entries, as the
   * log is indexed.
   */
  async decisionVoteEvents(
    decisionId: string,
    entryIds: readonly string[],
    after: LogPlace | null,
    upTo: LogPlace,
    limit: number
  ): Promise<LoggedVote[]> {
    const out: LoggedVote[] = [];
    for (const chunk of statementChunks(entryIds, () => ID_BYTES)) {
      const rows = await this.db.execute<Record<string, unknown>>(
        `select height, seq, block_time, kind, origin, entry_id, actor, data
           from ${CHAIN_EVENTS_TABLE}
          where entry_id in (:ids) and kind = 'VOTE'
            and decision_id = :decisionId
            and (height > :afterHeight
                 or (height = :afterHeight and seq > :afterSeq))
            and (height < :upToHeight
                 or (height = :upToHeight and seq <= :upToSeq))
          order by height, seq
          limit :limit`,
        {
          ids: chunk,
          decisionId,
          afterHeight: after?.height ?? -1,
          afterSeq: after?.seq ?? 0,
          upToHeight: upTo.height,
          upToSeq: upTo.seq,
          limit
        }
      );
      for (const row of rows) {
        out.push({
          height: num(row.height),
          seq: num(row.seq),
          blockTime: num(row.block_time),
          kind: 'VOTE',
          origin: String(row.origin) as LoggedVote['origin'],
          entryId: textOrNull(row.entry_id),
          actor: textOrNull(row.actor),
          data: json(row.data)
        });
      }
    }
    return out
      .sort((a, b) => a.height - b.height || a.seq - b.seq)
      .slice(0, limit);
  }

  /**
   * The votes RELEASE events took off these entries: each (entry, voter)'s
   * last released value.
   */
  async releasedVotes(
    entryIds: readonly string[]
  ): Promise<Map<string, Map<string, string>>> {
    const out = new Map<string, Map<string, string>>();
    for (const chunk of statementChunks(entryIds, () => ID_BYTES)) {
      const rows = await this.db.execute<{
        entry_id: string;
        actor: string;
        data: unknown;
      }>(
        `select entry_id, actor, data from ${CHAIN_EVENTS_TABLE}
          where entry_id in (:ids) and kind = 'VOTE' and origin = 'RELEASE'
          order by height, seq`,
        { ids: chunk }
      );
      for (const row of rows) {
        const old = json(row.data).oldValue;
        if (typeof old !== 'string' || !row.actor) continue;
        const votes = out.get(row.entry_id) ?? new Map<string, string>();
        votes.set(row.actor, old);
        out.set(row.entry_id, votes);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ profiles

  /** Profile ids of these principals; unmapped ones are left out. */
  async profilesOfPrincipals(
    principals: readonly string[],
    connection?: Conn
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const chunk of statementChunks(
      Array.from(new Set(principals)),
      () => ID_BYTES
    )) {
      const rows = await this.db.execute<{
        principal_id: string;
        profile_id: string;
      }>(
        `select principal_id, profile_id from ${IDENTITY_CHAIN_PRINCIPALS}
          where principal_id in (:ids)`,
        { ids: chunk },
        opts(connection)
      );
      for (const row of rows) out.set(row.principal_id, row.profile_id);
    }
    return out;
  }

  /** Which of these profiles have a principal. */
  async profilesWithPrincipal(
    profileIds: readonly string[],
    connection?: Conn
  ): Promise<Set<string>> {
    const out = new Set<string>();
    for (const chunk of statementChunks(
      Array.from(new Set(profileIds)),
      () => ID_BYTES
    )) {
      const rows = await this.db.execute<{ profile_id: string }>(
        `select profile_id from ${IDENTITY_CHAIN_PRINCIPALS}
          where profile_id in (:ids)`,
        { ids: chunk },
        opts(connection)
      );
      for (const row of rows) out.add(row.profile_id);
    }
    return out;
  }

  // ------------------------------------------------------------ 6529.io

  /**
   * A competition and its rows. With a connection, the competition row is
   * locked first (the runtime's rule for every competition write). Winners,
   * winner votes and awards are read for `decisionIds` only (the results
   * the chain counted): older ones are 6529.io's and never change here.
   */
  async targetCompetition(
    competitionId: string,
    decisionIds: readonly string[],
    history: HistoryRead | null,
    connection?: Conn
  ): Promise<TargetCompetitionState | null> {
    const row = await this.db.oneOrNull<Record<string, unknown>>(
      `select id, wave_id, legacy_wave_id, type, lifecycle, decision_config,
              outcome_config, published_at, ended_at, archived_at
         from ${COMPETITIONS_TABLE} where id = :competitionId
         ${connection ? 'for update' : ''}`,
      { competitionId },
      opts(connection)
    );
    if (!row) return null;
    const params = { competitionId };
    const capabilities = await this.db.execute<{ capability: string }>(
      `select capability from ${COMPETITION_CAPABILITIES_TABLE}
        where competition_id = :competitionId order by capability`,
      params,
      opts(connection)
    );
    const competition: TargetCompetition = {
      id: String(row.id),
      waveId: String(row.wave_id),
      legacyWaveId: textOrNull(row.legacy_wave_id),
      type: String(row.type),
      lifecycle: String(row.lifecycle),
      decisionConfig: json(row.decision_config),
      outcomeConfig: jsonArray(row.outcome_config),
      capabilities: capabilities.map((c) => c.capability),
      publishedAt: numOrNull(row.published_at),
      endedAt: numOrNull(row.ended_at),
      archivedAt: numOrNull(row.archived_at)
    };
    const entries = await this.db.execute<Record<string, unknown>>(
      `select * from ${COMPETITION_ENTRIES_TABLE}
        where competition_id = :competitionId order by id`,
      params,
      opts(connection)
    );
    const votes = await this.db.execute<Record<string, unknown>>(
      `select id, entry_id, voter_profile_id, value, credit_spent, created_at,
              updated_at
         from ${COMPETITION_VOTES_TABLE} where competition_id = :competitionId
        order by entry_id, voter_profile_id`,
      params,
      opts(connection)
    );
    const runtime = await this.db.execute<Record<string, unknown>>(
      `select entry_id, real_time_rating, last_increased_at,
              over_threshold_since, updated_at
         from ${COMPETITION_ENTRY_RUNTIME_TABLE}
        where competition_id = :competitionId order by entry_id`,
      params,
      opts(connection)
    );
    const board = await this.db.execute<Record<string, unknown>>(
      `select entry_id, drop_id, rating, real_time_rating, \`rank\`,
              submitted_at, updated_at, ordering_time, decision_rating,
              over_threshold_since, published_at
         from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE}
        where competition_id = :competitionId order by entry_id`,
      params,
      opts(connection)
    );
    const decisions = await this.db.execute<Record<string, unknown>>(
      `select id, scheduled_at, decided_at, status, execution_key, created_at
         from ${COMPETITION_DECISIONS_TABLE}
        where competition_id = :competitionId order by scheduled_at, id`,
      params,
      opts(connection)
    );
    const ids = Array.from(new Set(decisionIds));
    const byDecision = async (sql: string) =>
      ids.length
        ? this.db.execute<Record<string, unknown>>(
            sql,
            { competitionId, ids },
            opts(connection)
          )
        : [];
    const winners = await byDecision(
      `select decision_id, entry_id, \`rank\`, final_rating
         from ${COMPETITION_DECISION_WINNERS_TABLE}
        where competition_id = :competitionId and decision_id in (:ids)
        order by decision_id, entry_id`
    );
    const winnerVotes = await byDecision(
      `select decision_id, entry_id, voter_profile_id, value
         from ${COMPETITION_WINNER_VOTES_TABLE}
        where competition_id = :competitionId and decision_id in (:ids)
        order by decision_id, entry_id, voter_profile_id`
    );
    const awards = await byDecision(
      `select id, decision_id, entry_id, outcome_position
         from ${COMPETITION_OUTCOME_AWARDS_TABLE}
        where competition_id = :competitionId and decision_id in (:ids)
        order by decision_id, entry_id, outcome_position`
    );
    const scoreRows =
      history === null
        ? []
        : await this.scoreHistory(competitionId, history, connection);
    return {
      competition,
      scoreHistory: scoreRows.flatMap((h): TargetScorePoint[] =>
        h.entry_id === null
          ? []
          : [
              {
                kind: String(h.kind) === 'VOTER' ? 'VOTER' : 'AGGREGATE',
                entryId: String(h.entry_id),
                voterProfileId: String(h.voter_profile_id),
                value: num(h.value),
                occurredAt: num(h.occurred_at),
                sequence: num(h.sequence)
              }
            ]
      ),
      entries: entries.map(
        (e): TargetEntry => ({
          id: String(e.id),
          dropId: String(e.drop_id),
          submitterId: String(e.submitter_id),
          status: String(e.status),
          configVersion: num(e.config_version),
          submittedAt: num(e.submitted_at),
          withdrawnAt: numOrNull(e.withdrawn_at),
          disqualifiedAt: numOrNull(e.disqualified_at),
          wonAt: numOrNull(e.won_at),
          rank: numOrNull(e.rank),
          decisionId: textOrNull(e.decision_id)
        })
      ),
      votes: votes.map(
        (v): TargetVote => ({
          id: String(v.id),
          entryId: String(v.entry_id),
          voterProfileId: String(v.voter_profile_id),
          value: num(v.value),
          creditSpent: num(v.credit_spent),
          createdAt: num(v.created_at),
          updatedAt: num(v.updated_at)
        })
      ),
      runtime: runtime.map(
        (r): TargetRuntime => ({
          entryId: String(r.entry_id),
          realTimeRating: num(r.real_time_rating),
          lastIncreasedAt: numOrNull(r.last_increased_at),
          overThresholdSince: numOrNull(r.over_threshold_since),
          updatedAt: num(r.updated_at)
        })
      ),
      board: board.map(
        (b): TargetBoardRow => ({
          entryId: String(b.entry_id),
          dropId: String(b.drop_id),
          rating: num(b.rating),
          realTimeRating: num(b.real_time_rating),
          rank: numOrNull(b.rank),
          submittedAt: num(b.submitted_at),
          updatedAt: num(b.updated_at),
          orderingTime: numOrNull(b.ordering_time),
          decisionRating: numOrNull(b.decision_rating),
          overThresholdSince: numOrNull(b.over_threshold_since),
          publishedAt: numOrNull(b.published_at)
        })
      ),
      decisions: decisions.map(
        (d): TargetDecision => ({
          id: String(d.id),
          scheduledAt: num(d.scheduled_at),
          decidedAt: numOrNull(d.decided_at),
          status: String(d.status),
          executionKey: String(d.execution_key),
          createdAt: num(d.created_at)
        })
      ),
      winners: winners.map(
        (w): TargetWinner => ({
          decisionId: String(w.decision_id),
          entryId: String(w.entry_id),
          rank: num(w.rank),
          finalRating: num(w.final_rating)
        })
      ),
      winnerVotes: winnerVotes.map(
        (v): TargetWinnerVote => ({
          decisionId: String(v.decision_id),
          entryId: String(v.entry_id),
          voterProfileId: String(v.voter_profile_id),
          value: num(v.value)
        })
      ),
      awards: awards.map(
        (a): TargetAward => ({
          id: String(a.id),
          decisionId: String(a.decision_id),
          entryId: String(a.entry_id),
          outcomePosition: num(a.outcome_position)
        })
      )
    };
  }

  // ------------------------------------------------------------ writes

  /**
   * The score history a plan weighs (HistoryRead), read by the entry-time
   * index, so a year of a competition's history costs what its entries do:
   * the points from `since` of its ACTIVE entries and its newest winners;
   * each of those entries' last AGGREGATE point before `since`; and the
   * winners' last VOTER point before it, per voter. "Last" is by time, then
   * sequence.
   */
  private async scoreHistory(
    competitionId: string,
    history: HistoryRead,
    connection?: Conn
  ): Promise<Record<string, unknown>[]> {
    const winners = Array.from(new Set(history.winnerDropIds));
    const entries = `e.competition_id = :competitionId and (e.status = 'ACTIVE'${
      winners.length ? ' or e.drop_id in (:winners)' : ''
    })`;
    const columns =
      'h.kind, h.entry_id, h.voter_profile_id, h.value, h.occurred_at, h.sequence';
    const index = 'force index (idx_competition_score_history_entry_time)';
    const parts = [
      `select ${columns}
         from ${COMPETITION_ENTRIES_TABLE} e
         join ${COMPETITION_SCORE_HISTORY_TABLE} h ${index}
           on h.competition_id = e.competition_id and h.entry_id = e.id
          and h.occurred_at >= :since
        where ${entries}`,
      `select l.kind, l.entry_id, l.voter_profile_id, l.value, l.occurred_at, l.sequence
         from ${COMPETITION_ENTRIES_TABLE} e
         join lateral (
           select ${columns}
             from ${COMPETITION_SCORE_HISTORY_TABLE} h ${index}
            where h.competition_id = e.competition_id and h.entry_id = e.id
              and h.kind = 'AGGREGATE' and h.occurred_at < :since
            order by h.occurred_at desc, h.sequence desc
            limit 1) l on true
        where ${entries}`
    ];
    if (winners.length) {
      parts.push(
        `select l.kind, l.entry_id, l.voter_profile_id, l.value, l.occurred_at, l.sequence
           from ${COMPETITION_ENTRIES_TABLE} e
           join lateral (
             select ${columns},
                    row_number() over (partition by h.voter_profile_id
                      order by h.occurred_at desc, h.sequence desc) as place
               from ${COMPETITION_SCORE_HISTORY_TABLE} h ${index}
              where h.competition_id = e.competition_id and h.entry_id = e.id
                and h.kind = 'VOTER' and h.occurred_at < :since) l
             on l.place = 1
          where e.competition_id = :competitionId and e.drop_id in (:winners)`
      );
    }
    return this.db.execute<Record<string, unknown>>(
      parts.join(' union all '),
      { competitionId, since: history.since, winners },
      opts(connection)
    );
  }

  /**
   * Runs `fn` in one READ COMMITTED transaction: a decision's rows are
   * replaced in place, and REPEATABLE READ's gap locks deadlock
   * concurrent delete-then-insert writers.
   */
  async inTransaction<T>(fn: (connection: Conn) => Promise<T>): Promise<T> {
    return this.executeNativeQueriesInTransaction(fn, {
      isolationLevel: 'READ COMMITTED'
    });
  }

  /**
   * Applies a decision's writes, inside the caller's transaction (which
   * holds the competition row lock).
   */
  async applyWrites(
    plan: Pick<
      DecisionPlan,
      'competitionId' | 'waveId' | 'at' | 'network' | 'capabilities' | 'writes'
    >,
    connection: Conn
  ): Promise<void> {
    const rebuild = this.mode === 'rebuild';
    await applyNativeEntryWrites(
      this.db,
      plan.competitionId,
      plan.writes.nativeEntries,
      connection,
      rebuild ? NO_COLLABORATIONS : undefined,
      !rebuild
    );
    await applyEntryRemovals(plan.writes.entryRemovals, connection);
    await applyHistoryWrites(
      this.db,
      plan.network ?? '',
      { id: plan.competitionId, waveId: plan.waveId },
      plan.writes.history,
      plan.at,
      connection,
      rebuild ? NO_OUTBOX : undefined,
      !rebuild
    );
    await applyVoteWrites(this.db, plan.competitionId, plan.writes, connection);
    await applyResultWrites(
      this.db,
      { id: plan.competitionId, waveId: plan.waveId },
      rebuild
        ? { ...plan.writes.results, claimBuilds: [] }
        : plan.writes.results,
      connection
    );
    // A rebuild leaves the collaborations, the claims and the outbox to
    // their own areas.
    if (rebuild) return;
    // The runtime freezes the Main Stage winner's collaborations at its
    // decision (a no-op unless the competition is the designated one).
    for (const dropId of plan.writes.results.mainStageMints) {
      await freezeMemeCollaborationForNativeDecision(
        {
          competition: {
            id: plan.competitionId,
            capabilities: [CompetitionCapability.MAIN_STAGE]
          },
          winners: [{ rank: 1, drop_id: dropId }],
          skipped: false
        },
        { connection }
      );
    }
    await applyOutboxEvents(plan, connection);
  }

  // ------------------------------------------------------------ native entries

  /**
   * The wave of a competition and which of these drop ids already have an
   * entry in it; null without the competition. Read before an entry made on
   * the chain is fetched and checked, outside the decision's transaction.
   */
  async nativeEntryContext(
    competitionId: string,
    dropIds: readonly string[]
  ): Promise<NativeEntryContext | null> {
    const competition = await this.db.oneOrNull<Record<string, unknown>>(
      `select c.wave_id, c.participation_config, w.name as wave_name,
              exists(select 1 from ${COMPETITION_CAPABILITIES_TABLE} cap
                where cap.competition_id = c.id and cap.wave_id = c.wave_id
                  and cap.capability = 'MAIN_STAGE') as main_stage
         from ${COMPETITIONS_TABLE} c
         left join ${WAVES_TABLE} w on w.id = c.wave_id
        where c.id = :competitionId`,
      { competitionId }
    );
    if (!competition) return null;
    const existing = new Set<string>();
    for (const chunk of statementChunks(dropIds, () => ID_BYTES)) {
      const rows = await this.db.execute<{ drop_id: string }>(
        `select drop_id from ${COMPETITION_ENTRIES_TABLE}
          where competition_id = :competitionId and drop_id in (:ids)`,
        { competitionId, ids: chunk }
      );
      for (const row of rows) existing.add(row.drop_id.toLowerCase());
    }
    const participation = json(competition.participation_config);
    return {
      waveId: String(competition.wave_id),
      waveName: textOrNull(competition.wave_name),
      participation,
      terms: textOrNull(participation.terms),
      signatureRequired: participation.signature_required === true,
      mainStage: Number(competition.main_stage) === 1,
      existing
    };
  }

  /** The entries held back, with the reason and a delay's next try. */
  async heldEntries(
    entryIds: readonly string[]
  ): Promise<Map<string, EntryHold>> {
    const out = new Map<string, EntryHold>();
    for (const chunk of statementChunks(entryIds, () => ID_BYTES)) {
      const rows = await this.db.execute<Record<string, unknown>>(
        `select entry_id, reason, retry_at, attempts
           from ${CHAIN_ENTRY_HOLDS_TABLE} where entry_id in (:ids)`,
        { ids: chunk }
      );
      for (const row of rows) {
        out.set(String(row.entry_id), {
          reason: String(row.reason),
          retryAt: numOrNull(row.retry_at),
          attempts: num(row.attempts)
        });
      }
    }
    return out;
  }

  /**
   * Holds an entry back: for good (retryAt null), or until retryAt, a
   * delay counted in attempts. A refusal is never turned into a delay. A
   * rebuild keeps no holds: it reads the live mirror's.
   */
  async holdEntry(
    entryId: string,
    competitionId: string,
    hold: EntryHold,
    now: number
  ): Promise<void> {
    if (this.mode === 'rebuild') return;
    await this.db.execute(
      `insert into ${CHAIN_ENTRY_HOLDS_TABLE}
         (entry_id, competition_id, reason, held_at, retry_at, attempts)
       values (:entryId, :competitionId, :reason, :now, :retryAt, :attempts)
       on duplicate key update
         reason = if(${CHAIN_ENTRY_HOLDS_TABLE}.retry_at is null,
           ${CHAIN_ENTRY_HOLDS_TABLE}.reason, :reason),
         attempts = if(${CHAIN_ENTRY_HOLDS_TABLE}.retry_at is null,
           ${CHAIN_ENTRY_HOLDS_TABLE}.attempts, :attempts),
         retry_at = if(${CHAIN_ENTRY_HOLDS_TABLE}.retry_at is null,
           null, :retryAt)`,
      {
        entryId,
        competitionId,
        reason: hold.reason.slice(0, 100),
        retryAt: hold.retryAt,
        attempts: hold.attempts,
        now
      }
    );
  }

  /** An entry no longer held (it went through); a rebuild keeps them. */
  async releaseHold(entryId: string): Promise<void> {
    if (this.mode === 'rebuild') return;
    await this.db.execute(
      `delete from ${CHAIN_ENTRY_HOLDS_TABLE}
        where entry_id = :entryId and retry_at is not null`,
      { entryId }
    );
  }

  // ------------------------------------------------------------ imported rows

  /**
   * A rebuild's rows of an imported decision's entries, results and winners
   * that 6529.io has none of (waves-chain-mirror.legacy-rows.ts), in the
   * decision's transaction; a row there is left as it is. The live mirror
   * writes none (6529.io's own rows are there). Returns what waits, by
   * reason.
   */
  async writeImportedDecisionRows(
    chain: ChainDecisionState,
    competitionId: string,
    connection: Conn
  ): Promise<Record<string, number>> {
    if (this.mode !== 'rebuild') return {};
    const options = opts(connection);
    const competition = await this.db.oneOrNull<{
      wave_id: string;
      legacy_wave_id: string | null;
      config_version: number | string;
    }>(
      `select wave_id, legacy_wave_id, config_version
         from ${COMPETITIONS_TABLE} where id = :competitionId`,
      { competitionId },
      options
    );
    if (!competition) return {};
    const authors = await this.profilesOfPrincipals(
      chain.entries.filter((e) => e.legacyId).map((e) => e.author),
      connection
    );
    const counter = new PlanCounter();
    const rows = importedDecisionRows(
      chain,
      {
        id: competitionId,
        waveId: competition.wave_id,
        primary: competition.legacy_wave_id !== null,
        configVersion: num(competition.config_version)
      },
      authors,
      counter
    );
    await this.insertIgnore(
      COMPETITION_ENTRIES_TABLE,
      rows.entries as unknown as Record<string, unknown>[],
      options
    );
    await this.insertIgnore(
      COMPETITION_DECISIONS_TABLE,
      rows.results as unknown as Record<string, unknown>[],
      options
    );
    await this.insertIgnore(
      COMPETITION_DECISION_WINNERS_TABLE,
      rows.winners as unknown as Record<string, unknown>[],
      options
    );
    return counter.waiting;
  }

  /** Rows inserted where none is, in statements under the proxy's limit. */
  private async insertIgnore(
    table: string,
    rows: readonly Record<string, unknown>[],
    options: ReturnType<typeof opts>
  ): Promise<void> {
    if (!rows.length) return;
    const columns = Object.keys(rows[0]);
    for (const chunk of statementChunks(rows, () => 400)) {
      const params: Record<string, unknown> = {};
      const values = chunk.map((row, i) => {
        for (const column of columns) params[`${column}_${i}`] = row[column];
        return `(${columns.map((column) => `:${column}_${i}`).join(', ')})`;
      });
      await this.db.execute(
        `insert ignore into ${table}
           (${columns.map((column) => `\`${column}\``).join(', ')})
         values ${values.join(', ')}`,
        params,
        options
      );
    }
  }

  // ------------------------------------------------------------ documents

  async findDocument(cid: string): Promise<Uint8Array | null> {
    // As hex: the driver's type casting is not trusted with blobs.
    const rows = await this.db.execute<{ hex: string | null }>(
      `select hex(bytes) as hex from ${CHAIN_DOCS_TABLE}
        where cid = :cid order by part`,
      { cid }
    );
    if (!rows.length) return null;
    return new Uint8Array(
      Buffer.concat(rows.map((row) => Buffer.from(row.hex ?? '', 'hex')))
    );
  }

  async saveDocument(
    cid: string,
    docClass: number,
    bytes: Uint8Array
  ): Promise<void> {
    // A row a part of DOC_PART_BYTES, each statement under the proxy's
    // limit, in one transaction; a document saved again (its copy here
    // didn't match its CID) replaces the old rows.
    const all = Buffer.from(bytes);
    const parts: string[] = [];
    for (let i = 0; i < all.length || i === 0; i += DOC_PART_BYTES) {
      parts.push(all.subarray(i, i + DOC_PART_BYTES).toString('hex'));
    }
    await this.executeNativeQueriesInTransaction(async (connection) => {
      const options = { wrappedConnection: connection };
      await this.db.execute(
        `delete from ${CHAIN_DOCS_TABLE} where cid = :cid`,
        { cid },
        options
      );
      for (let part = 0; part < parts.length; part++) {
        await this.db.execute(
          `insert into ${CHAIN_DOCS_TABLE} (cid, part, doc_class, bytes, first_seen)
           values (:cid, :part, :docClass, unhex(:hex), :now)`,
          { cid, part, docClass, hex: parts[part], now: Date.now() },
          options
        );
      }
    });
  }
}

function decisionOf(row: Record<string, unknown>): ChainDecisionRow {
  return {
    decisionId: String(row.decision_id),
    legacyId: textOrNull(row.legacy_id),
    waveId: String(row.wave_id),
    status: String(row.status),
    kind: String(row.kind),
    nextResultTime: num(row.next_result_time),
    origin: String(row.origin),
    height: num(row.height),
    data: json(row.data)
  };
}

function entryOf(row: Record<string, unknown>): ChainEntryRow {
  return {
    entryId: String(row.entry_id),
    legacyId: textOrNull(row.legacy_id),
    decisionId: String(row.decision_id),
    author: String(row.author),
    status: String(row.status),
    total: String(row.total),
    origin: String(row.origin),
    height: num(row.height),
    data: json(row.data)
  };
}

export const wavesChainMirrorDb = new WavesChainMirrorDb(
  () => writerPoolExecutor
);
