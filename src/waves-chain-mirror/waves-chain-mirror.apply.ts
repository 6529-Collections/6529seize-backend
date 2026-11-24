import {
  CHAIN_CLAIM_BUILDS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITIONS_TABLE,
  WAVES_CHAIN_MIRROR_EVENTS_TABLE
} from '@/constants';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';
import { statementChunks } from '@/waves-chain-index/waves-chain-index.db';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import {
  memeCollaborationsService,
  MemeCollaborationsService
} from '@/meme-collaborations/meme-collaborations.service';
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';
import { deleteDrop, DeleteDropUseCase } from '@/drops/delete-drop.use-case';
import { EntryRemoval } from './waves-chain-mirror.entries';
import { HistoryWrite } from './waves-chain-mirror.history';
import { DecisionPlan } from './waves-chain-mirror.plan';
import { nativeScoreSequence } from '@/competitions/competition-score-history';
import { recordNativePrimaryVoteActivity } from '@/competitions/competition-vote-activity.writer';
import {
  nativeCompetitionRuntimeRepository,
  NativeCompetitionRuntimeRepository
} from '@/competitions/native-competition-runtime.repository';
import {
  nativeEntryDrop,
  NativeEntryWrite
} from './waves-chain-mirror.native-entries';
import { ResultWrites } from './waves-chain-mirror.results';
import { VoteWrites } from './waves-chain-mirror.votes';

/**
 * The SQL of a plan's writes, inside the caller's transaction. Each
 * statement stays under about 12 KB (statementChunks): the RDS proxy pins a
 * session on a larger one.
 */

type Conn = ConnectionWrapper<any>;

/** About the bytes of a row of ids and numbers in a statement. */
const ROW_BYTES = 320;
const ID_BYTES = 48;

function quoted(column: string): string {
  return `\`${column}\``;
}

/**
 * Inserts rows, or updates the columns `updates` names on a duplicate key
 * (the row's own key or a unique one).
 */
export async function upsertRows(
  db: SqlExecutor,
  table: string,
  columns: readonly string[],
  updates: readonly string[],
  rows: readonly Record<string, unknown>[],
  connection: Conn
): Promise<void> {
  for (const chunk of statementChunks(rows, () => ROW_BYTES)) {
    const params: Record<string, unknown> = {};
    const values = chunk.map(
      (row, i) =>
        `(${columns
          .map((column, j) => {
            params[`p${i}_${j}`] = row[column];
            return `:p${i}_${j}`;
          })
          .join(', ')})`
    );
    await db.execute(
      `insert into ${table} (${columns.map(quoted).join(', ')})
       values ${values.join(', ')} as new
       on duplicate key update ${updates
         .map((c) => `${quoted(c)} = new.${quoted(c)}`)
         .join(', ')}`,
      params,
      { wrappedConnection: connection }
    );
  }
}

/** Deletes a competition's rows whose `column` is one of `ids`. */
export async function deleteRows(
  db: SqlExecutor,
  table: string,
  competitionId: string,
  column: string,
  ids: readonly string[],
  connection: Conn
): Promise<void> {
  for (const chunk of statementChunks(ids, () => ID_BYTES)) {
    await db.execute(
      `delete from ${table}
        where competition_id = :competitionId and ${quoted(column)} in (:ids)`,
      { competitionId, ids: chunk },
      { wrappedConnection: connection }
    );
  }
}

export async function applyVoteWrites(
  db: SqlExecutor,
  competitionId: string,
  writes: VoteWrites,
  connection: Conn
): Promise<void> {
  await deleteRows(
    db,
    COMPETITION_VOTES_TABLE,
    competitionId,
    'id',
    writes.votes.remove,
    connection
  );
  await upsertRows(
    db,
    COMPETITION_VOTES_TABLE,
    [
      'id',
      'competition_id',
      'entry_id',
      'voter_profile_id',
      'value',
      'credit_spent',
      'created_at',
      'updated_at'
    ],
    ['value', 'credit_spent', 'updated_at'],
    writes.votes.upsert.map((v) => ({
      id: v.id,
      competition_id: competitionId,
      entry_id: v.entryId,
      voter_profile_id: v.voterProfileId,
      value: v.value,
      credit_spent: v.creditSpent,
      created_at: v.createdAt,
      updated_at: v.updatedAt
    })),
    connection
  );
  await upsertRows(
    db,
    COMPETITION_ENTRY_RUNTIME_TABLE,
    [
      'competition_id',
      'entry_id',
      'real_time_rating',
      'last_increased_at',
      'over_threshold_since',
      'updated_at'
    ],
    [
      'real_time_rating',
      'last_increased_at',
      'over_threshold_since',
      'updated_at'
    ],
    writes.runtime.upsert.map((r) => ({
      competition_id: competitionId,
      entry_id: r.entryId,
      real_time_rating: r.realTimeRating,
      last_increased_at: r.lastIncreasedAt,
      over_threshold_since: r.overThresholdSince,
      updated_at: r.updatedAt
    })),
    connection
  );
  await deleteRows(
    db,
    COMPETITION_LEADERBOARD_ENTRIES_TABLE,
    competitionId,
    'entry_id',
    writes.board.remove,
    connection
  );
  await upsertRows(
    db,
    COMPETITION_LEADERBOARD_ENTRIES_TABLE,
    [
      'competition_id',
      'entry_id',
      'drop_id',
      'rating',
      'real_time_rating',
      'rank',
      'submitted_at',
      'updated_at',
      'ordering_time',
      'decision_rating',
      'over_threshold_since',
      'published_at'
    ],
    [
      'drop_id',
      'rating',
      'real_time_rating',
      'rank',
      'submitted_at',
      'updated_at',
      'ordering_time',
      'decision_rating',
      'over_threshold_since',
      'published_at'
    ],
    writes.board.upsert.map((b) => ({
      competition_id: competitionId,
      entry_id: b.entryId,
      drop_id: b.dropId,
      rating: b.rating,
      real_time_rating: b.realTimeRating,
      rank: b.rank,
      submitted_at: b.submittedAt,
      updated_at: b.updatedAt,
      ordering_time: b.orderingTime,
      decision_rating: b.decisionRating,
      over_threshold_since: b.overThresholdSince,
      published_at: b.publishedAt
    })),
    connection
  );
}

/**
 * Removes entries the chain withdrew or disqualified with 6529.io's own
 * drop delete, as a backend delete (no deleter, allowed through the
 * freeze): the drop and its rows, then the entry with its votes, board and
 * runtime rows (an anonymous decision keeps it as WITHDRAWN). That delete
 * queues COMPETITION_ENTRY_DELETED for the sockets, as it does on
 * 6529.io; no event of it publishes a claim.
 */
export async function applyEntryRemovals(
  removals: readonly EntryRemoval[],
  connection: Conn,
  drops: Pick<DeleteDropUseCase, 'execute'> = deleteDrop
): Promise<void> {
  for (const removal of removals) {
    await drops.execute(
      { drop_id: removal.dropId, deletion_purpose: 'SYSTEM_DELETE' },
      { connection }
    );
  }
}

export async function applyResultWrites(
  db: SqlExecutor,
  competition: { readonly id: string; readonly waveId: string },
  writes: ResultWrites,
  connection: Conn
): Promise<void> {
  const competitionId = competition.id;
  await upsertRows(
    db,
    COMPETITION_DECISIONS_TABLE,
    [
      'id',
      'competition_id',
      'scheduled_at',
      'decided_at',
      'status',
      'execution_key',
      'created_at'
    ],
    ['decided_at', 'status', 'execution_key'],
    writes.decisions.map((d) => ({
      id: d.id,
      competition_id: competitionId,
      scheduled_at: d.scheduledAt,
      decided_at: d.decidedAt,
      status: d.status,
      execution_key: d.executionKey,
      created_at: d.createdAt
    })),
    connection
  );
  await upsertRows(
    db,
    COMPETITION_DECISION_WINNERS_TABLE,
    [
      'decision_id',
      'entry_id',
      'competition_id',
      'rank',
      'final_rating',
      'created_at'
    ],
    ['rank', 'final_rating'],
    writes.winners.map((w) => ({
      decision_id: w.decisionId,
      entry_id: w.entryId,
      competition_id: competitionId,
      rank: w.rank,
      final_rating: w.finalRating,
      created_at: w.createdAt
    })),
    connection
  );
  for (const winner of writes.winnerEntries) {
    await db.execute(
      `update ${COMPETITION_ENTRIES_TABLE}
          set status = 'WINNER', won_at = :wonAt, \`rank\` = :rank,
              decision_id = :decisionId
        where id = :id and competition_id = :competitionId
          and status in ('ACTIVE', 'WINNER')`,
      { ...winner, competitionId },
      { wrappedConnection: connection }
    );
  }
  await upsertRows(
    db,
    COMPETITION_WINNER_VOTES_TABLE,
    ['competition_id', 'decision_id', 'entry_id', 'voter_profile_id', 'value'],
    ['value'],
    writes.winnerVotes.map((v) => ({
      competition_id: competitionId,
      decision_id: v.decisionId,
      entry_id: v.entryId,
      voter_profile_id: v.voterProfileId,
      value: v.value
    })),
    connection
  );
  await upsertRows(
    db,
    COMPETITION_OUTCOME_AWARDS_TABLE,
    [
      'id',
      'competition_id',
      'decision_id',
      'entry_id',
      'outcome_position',
      'award',
      'created_at'
    ],
    ['award'],
    writes.awards.map((a) => ({
      id: a.id,
      competition_id: competitionId,
      decision_id: a.decisionId,
      entry_id: a.entryId,
      outcome_position: a.outcomePosition,
      award: JSON.stringify(a.award),
      created_at: a.createdAt
    })),
    connection
  );
  const change = writes.competition;
  if (change) {
    const setNext = change.nextDecisionTime !== undefined;
    await db.execute(
      `update ${COMPETITIONS_TABLE}
          set lifecycle = coalesce(:lifecycle, lifecycle),
              published_at = if(:lifecycle = 'PUBLISHED',
                coalesce(published_at, :at), published_at),
              ended_at = if(:lifecycle = 'ENDED', coalesce(ended_at, :at),
                ended_at),
              archived_at = if(:lifecycle = 'ARCHIVED',
                coalesce(archived_at, :at), archived_at),
              decision_config = if(:setNext,
                json_set(decision_config, '$.next_decision_time', :next),
                decision_config),
              updated_at = :at
        where id = :competitionId and lifecycle = :from`,
      {
        competitionId,
        lifecycle: change.lifecycle,
        from: change.lifecycleFrom,
        setNext: setNext ? 1 : 0,
        next: setNext ? change.nextDecisionTime : null,
        at: change.at
      },
      { wrappedConnection: connection }
    );
  }
  // Exactly once: only a row still skipped, with no drop, moves. Its
  // drop_id column (varchar(36), a legacy drop's UUID) stays empty: a
  // chain-made drop's id is the chain entry id, and the message carries it.
  for (const build of writes.claimBuilds) {
    await db.execute(
      `update ${CHAIN_CLAIM_BUILDS_TABLE}
          set status = 'pending', message = :message, reason = null
        where network = :network and decision_id = :decisionId
          and occurrence = :occurrence and status = 'skipped'
          and drop_id is null`,
      { ...build, message: JSON.stringify(build.message) },
      { wrappedConnection: connection }
    );
  }
  for (const event of writes.lifecycleEvents) {
    await db.execute(
      `insert ignore into ${COMPETITION_LIFECYCLE_EVENTS_TABLE}
         (id, competition_id, wave_id, previous_lifecycle, lifecycle,
          actor_id, created_at)
       values (:id, :competitionId, :waveId, :previous, :lifecycle, null, :at)`,
      { ...event, competitionId, waveId: competition.waveId },
      { wrappedConnection: connection }
    );
  }
}

/**
 * The drops and entries of entries made on the chain, through the create
 * path's own inserts (DropsDb), so their part, media, mention and metric
 * rows are the ones a create writes. A large part is one statement, as on
 * the create path.
 */
export async function applyNativeEntryWrites(
  db: SqlExecutor,
  competitionId: string,
  writes: readonly NativeEntryWrite[],
  connection: Conn,
  collaborations: Pick<
    MemeCollaborationsService,
    'onWrite'
  > = memeCollaborationsService,
  /** False in a rebuild: wave metrics are recomputed from drops after it. */
  waveMetrics = true
): Promise<void> {
  const drops = new DropsDb(() => db);
  for (const write of writes) {
    const { content } = write;
    const dropId = write.dropId;
    const waveId = write.waveId;
    await drops.insertDrop(nativeEntryDrop(write), connection, {
      deferMetrics: !waveMetrics
    });
    await drops.insertDropParts(
      content.parts.map((part, index) => ({
        drop_id: dropId,
        drop_part_id: index + 1,
        content: part.content,
        quoted_drop_id: part.quotedDropId,
        quoted_drop_part_id: part.quotedDropPartId,
        wave_id: waveId
      })),
      connection
    );
    await drops.insertDropMedia(
      content.parts.flatMap((part, index) =>
        part.media.map((media) => ({
          drop_id: dropId,
          drop_part_id: index + 1,
          url: media.url,
          mime_type: media.mimeType,
          media_upload_id: media.mediaUploadId,
          wave_id: waveId
        }))
      ),
      connection
    );
    await drops.insertDropMetadata(
      content.metadata.map((m) => ({
        drop_id: dropId,
        data_key: m.dataKey,
        data_value: m.dataValue,
        wave_id: waveId
      })),
      connection
    );
    await drops.insertMentions(
      content.mentionedUsers.map((user) => ({
        drop_id: dropId,
        mentioned_profile_id: user.profileId,
        handle_in_content: user.handle,
        wave_id: waveId
      })),
      connection
    );
    await drops.insertReferencedNfts(
      content.referencedNfts.map((nft) => ({
        ...nft,
        drop_id: dropId,
        wave_id: waveId
      })),
      connection
    );
    await drops.insertMentionedWaves(
      content.mentionedWaves.map((wave) => ({
        drop_id: dropId,
        wave_id: wave.waveId,
        wave_name_in_content: wave.name
      })),
      { connection }
    );
    await drops.insertDropGroupMentions(
      content.mentionedGroups.map((group) => ({
        drop_id: dropId,
        mentioned_group: group as DropGroupMention
      })),
      { connection }
    );
    await db.execute(
      `insert into ${COMPETITION_ENTRIES_TABLE}
         (id, competition_id, wave_id, drop_id, submitter_id, status,
          config_version, submitted_at)
       values (:id, :competitionId, :waveId, :dropId, :authorId, 'ACTIVE',
          :configVersion, :createdAt)`,
      {
        id: write.entryRowId,
        competitionId,
        waveId,
        dropId,
        authorId: write.authorId,
        configVersion: write.configVersion,
        createdAt: write.createdAt
      },
      { wrappedConnection: connection }
    );
    // The artwork's collaboration and its invitations, as the create path
    // records them for every drop write (a no-op for other entries).
    await collaborations.onWrite(
      nativeEntryModel(write),
      dropId,
      { connection },
      competitionId
    );
  }
}

/** A native entry as the create path's model of a new entry drop. */
export function nativeEntryModel(
  write: NativeEntryWrite
): CreateOrUpdateDropModel {
  const { content } = write;
  return {
    drop_id: null,
    wave_id: write.waveId,
    reply_to: null,
    title: content.title,
    parts: content.parts.map((part) => ({
      content: part.content,
      quoted_drop: null,
      media: part.media.map((media) => ({
        url: media.url,
        mime_type: media.mimeType,
        media_upload_id: media.mediaUploadId
      }))
    })),
    referenced_nfts: content.referencedNfts,
    mentioned_users: content.mentionedUsers.map((user) => ({
      handle: user.handle
    })),
    mentioned_waves: content.mentionedWaves.map((wave) => ({
      wave_id: wave.waveId,
      wave_name_in_content: wave.name
    })),
    metadata: content.metadata.map((m) => ({
      data_key: m.dataKey,
      data_value: m.dataValue
    })),
    hide_link_preview: content.hideLinkPreview,
    author_identity: write.authorId,
    author_id: write.authorId,
    drop_type: DropType.COMPETITION,
    mentioned_groups: content.mentionedGroups as DropGroupMention[],
    signature: null,
    is_additional_action_promised: content.isAdditionalActionPromised,
    ...(content.collaboratorIds.length
      ? { collaborator_ids: [...content.collaboratorIds] }
      : {})
  };
}

/**
 * The vote and score history of VOTE events, each once
 * (waves_chain_mirror_events), as recordVoteChange writes it: the vote
 * history row, the AGGREGATE and VOTER score history under its sequence,
 * the vote activity of a wave's primary decision, and the socket event.
 */
/** The first score sequence of a point written for a chain place alone. */
export const CHAIN_SCORE_SEQUENCE_BASE = 2 ** 51;
const SEQ_SPAN = 2 ** 20;

/**
 * The score history sequence of an AGGREGATE point with no vote history row
 * (an unmapped voter's change): `2^51 + height * 2^20 + seq`, unique per
 * chain place, between 6529.io's retained ids and its native range
 * (nativeScoreSequence, from 2^52).
 */
export function chainScoreSequence(height: number, seq: number): number {
  const sequence = CHAIN_SCORE_SEQUENCE_BASE + height * SEQ_SPAN + seq;
  if (
    !Number.isSafeInteger(sequence) ||
    seq < 0 ||
    seq >= SEQ_SPAN ||
    sequence >= 2 ** 52
  ) {
    throw new Error(`No score sequence for chain place ${height}:${seq}`);
  }
  return sequence;
}

export async function applyHistoryWrites(
  db: SqlExecutor,
  network: string,
  competition: { readonly id: string; readonly waveId: string },
  writes: readonly HistoryWrite[],
  at: number,
  connection: Conn,
  outbox: Pick<
    NativeCompetitionRuntimeRepository,
    'enqueueEvent'
  > = nativeCompetitionRuntimeRepository,
  /** The voter's profile activity log, as the runtime keeps it. */
  recordActivity = true
): Promise<void> {
  const options = { wrappedConnection: connection };
  for (const write of writes) {
    const marked = await db.execute(
      `insert ignore into ${WAVES_CHAIN_MIRROR_EVENTS_TABLE}
         (network, height, seq, applied_at)
       values (:network, :height, :seq, :at)`,
      { network, height: write.height, seq: write.seq, at },
      options
    );
    if (db.getAffectedRows(marked) === 0) continue;
    if (write.voterProfileId === null) {
      // An unmapped voter: the entry's total still moved. Its point takes a
      // sequence of its chain place, below the native range. A relaunched
      // chain's place can be an old chain's on the same competition (an
      // imported one keeps its id): the new chain's point replaces it.
      await db.execute(
        `insert into ${COMPETITION_SCORE_HISTORY_TABLE}
           (competition_id, kind, sequence, entry_id, drop_id, voter_profile_id,
            value, occurred_at, mutation_sequence)
         values (:competitionId, 'AGGREGATE', :scoreSequence, :entryId, :dropId,
            '', :aggregate, :occurredAt, null) as new
         on duplicate key update
           entry_id = new.entry_id, drop_id = new.drop_id,
           value = new.value, occurred_at = new.occurred_at`,
        {
          competitionId: competition.id,
          scoreSequence: chainScoreSequence(write.height, write.seq),
          entryId: write.entryRowId,
          dropId: write.dropId,
          aggregate: write.aggregate,
          occurredAt: write.occurredAt
        },
        options
      );
      continue;
    }
    await db.execute(
      `insert into ${COMPETITION_VOTE_HISTORY_TABLE}
         (competition_id, entry_id, voter_profile_id, value, previous_value,
          aggregate_value, credit_delta, occurred_at, proxy_id, contents,
          drop_id, submitter_id)
       values (:competitionId, :entryId, :voterProfileId, :value, :previous,
          :aggregate, :creditDelta, :occurredAt, null, :contents, :dropId,
          :submitterId)`,
      {
        competitionId: competition.id,
        entryId: write.entryRowId,
        voterProfileId: write.voterProfileId,
        value: write.value,
        previous: write.previous,
        aggregate: write.aggregate,
        creditDelta: Math.abs(write.value) - Math.abs(write.previous),
        occurredAt: write.occurredAt,
        contents: JSON.stringify({
          oldVote: write.previous,
          newVote: write.value,
          ...(write.reason ? { reason: write.reason } : {}),
          chain: { height: write.height, seq: write.seq }
        }),
        dropId: write.dropId,
        submitterId: write.submitterId
      },
      options
    );
    const [inserted] = await db.execute<{ id: number | string }>(
      `select last_insert_id() as id`,
      {},
      options
    );
    const sequence = Number(inserted.id);
    await db.execute(
      `insert into ${COMPETITION_SCORE_HISTORY_TABLE}
         (competition_id, kind, sequence, entry_id, drop_id, voter_profile_id,
          value, occurred_at, mutation_sequence)
       values (:competitionId, 'AGGREGATE', :scoreSequence, :entryId, :dropId,
          '', :aggregate, :occurredAt, :sequence),
         (:competitionId, 'VOTER', :scoreSequence, :entryId, :dropId,
          :voterProfileId, :value, :occurredAt, :sequence)`,
      {
        competitionId: competition.id,
        scoreSequence: nativeScoreSequence(sequence),
        entryId: write.entryRowId,
        dropId: write.dropId,
        voterProfileId: write.voterProfileId,
        aggregate: write.aggregate,
        value: write.value,
        occurredAt: write.occurredAt,
        sequence
      },
      options
    );
    if (recordActivity) {
      await recordNativePrimaryVoteActivity(
        db,
        {
          competitionId: competition.id,
          entryId: write.entryRowId,
          voterProfileId: write.voterProfileId,
          previousVote: write.previous,
          value: write.value,
          occurredAt: write.occurredAt,
          ...(write.reason ? { reason: write.reason } : {})
        },
        sequence,
        { connection }
      );
    }
    await outbox.enqueueEvent(
      {
        key: `vote:${sequence}`,
        event_type: 'COMPETITION_VOTE_CHANGED',
        wave_id: competition.waveId,
        competition_id: competition.id,
        competition_entry_id: write.entryRowId,
        drop_id: write.dropId,
        occurred_at: write.occurredAt,
        data: { aggregate_rating: write.aggregate, version: sequence }
      },
      { connection }
    );
  }
}

/**
 * The socket and notification events the runtime queues with the same
 * writes, under its own keys, so a write applied twice queues nothing
 * twice. A decision's COMPETITION_DECISION_COMPLETED notifies the wave's
 * followers; its winners' claim and announcement are never made from it
 * for a chain result (getPrivilegedWinners leaves chain decisions out).
 */
export async function applyOutboxEvents(
  plan: Pick<
    DecisionPlan,
    'competitionId' | 'waveId' | 'at' | 'capabilities' | 'writes'
  >,
  connection: Conn,
  outbox: Pick<
    NativeCompetitionRuntimeRepository,
    'enqueueEvent'
  > = nativeCompetitionRuntimeRepository
): Promise<void> {
  const ctx = { connection };
  const base = {
    competition_id: plan.competitionId,
    wave_id: plan.waveId
  };
  const { writes } = plan;
  for (const entry of writes.nativeEntries) {
    await outbox.enqueueEvent(
      {
        ...base,
        key: `entry:chain:${entry.dropId}`,
        event_type: 'COMPETITION_ENTRY_CREATED',
        competition_entry_id: entry.entryRowId,
        drop_id: entry.dropId,
        occurred_at: entry.createdAt,
        data: {
          artwork_alert_eligible: plan.capabilities.includes('MAIN_STAGE'),
          submitter_id: entry.authorId,
          actor_id: entry.authorId,
          status: 'ACTIVE',
          reason: null
        }
      },
      ctx
    );
  }
  if (writes.board.upsert.length || writes.board.remove.length) {
    await outbox.enqueueEvent(
      {
        ...base,
        key: `leaderboard:${plan.at}`,
        event_type: 'COMPETITION_LEADERBOARD_UPDATED',
        occurred_at: plan.at,
        data: { snapshot_at: plan.at }
      },
      ctx
    );
  }
  const results = writes.results;
  for (const winner of results.winnerEntries) {
    await outbox.enqueueEvent(
      {
        ...base,
        key: `winner:${winner.decisionId}:${winner.id}`,
        event_type: 'COMPETITION_ENTRY_STATUS_CHANGED',
        competition_entry_id: winner.id,
        occurred_at: winner.wonAt,
        data: {
          previous_status: 'ACTIVE',
          status: 'WINNER',
          decision_id: winner.decisionId
        }
      },
      ctx
    );
  }
  for (const award of results.awards) {
    await outbox.enqueueEvent(
      {
        ...base,
        key: `award:${award.id}`,
        event_type: 'COMPETITION_OUTCOME_CREATED',
        competition_entry_id: award.entryId,
        occurred_at: award.createdAt,
        data: {
          decision_id: award.decisionId,
          outcome_award_id: award.id,
          outcome_position: award.outcomePosition
        }
      },
      ctx
    );
  }
  for (const decision of results.decisions) {
    if (decision.status !== 'COMPLETED') continue;
    await outbox.enqueueEvent(
      {
        ...base,
        key: `decision:${decision.id}`,
        event_type: 'COMPETITION_DECISION_COMPLETED',
        occurred_at: decision.decidedAt,
        data: {
          decision_id: decision.id,
          scheduled_at: decision.scheduledAt,
          winners: results.winners
            .filter((w) => w.decisionId === decision.id)
            .map((w) => ({
              entry_id: w.entryId,
              rank: w.rank,
              final_rating: w.finalRating
            })),
          capabilities: plan.capabilities
        }
      },
      ctx
    );
  }
}
