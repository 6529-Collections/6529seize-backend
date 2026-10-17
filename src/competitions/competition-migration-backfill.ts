import { readSequentially } from './competition-read-sequence';
import { collections } from '@/collections';
import { CompetitionMigrationContentRepository } from './competition-migration-content.repository';
import { isMigrationContentTable } from '@/competitions/competition-migration-capture';
import {
  CompetitionEntryRepository,
  CompetitionEntryContent
} from './competition-entry.repository';
import { CompetitionEntry } from './competition.types';
import { DropEntity, DropType } from '@/entities/IDrop';
import { competitionPayloadHash } from './competition-command-identity';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  DROP_RANK_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_VOTING_CREDIT_NFTS_TABLE,
  DROPS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { collectCompetitionPages } from './competition-page';
import { CompetitionRepository } from '@/competitions/competition.repository';
import { LegacyCompetitionAdapter } from '@/competitions/legacy-competition.adapter';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { CompetitionRoutingRecord } from '@/competitions/competition.types';
import { MigrationStage } from '@/competitions/competition-migration-policy';
import {
  stableUuid,
  legacyCompetitionEntryId,
  legacyCompetitionDecisionId,
  legacyCompetitionPauseId
} from '@/competitions/competition-id';
import { CompetitionStorageMode } from '@/entities/ICompetition';
import { CompetitionMigrationChangeEntity } from '@/entities/ICompetitionMigration';
import { parseMigrationChangeImage } from './competition-migration-journal';

const VOTER_COPY_QUERY_LIMIT = 25;
const LEADERBOARD_CLEANUP_QUERY_LIMIT = 25;

/** Bounded batches; the checkpoint is committed with the copied records. */
export class CompetitionMigrationBackfill {
  constructor(private readonly db: SqlExecutor) {}

  /** Ordered journal checkpointing coalesces repeated updates of a key to its
   * latest committed source state under the ownership lock. The retained before
   * image supplies deletion keys. Derived ranks are refreshed in bounded stages
   * before the applied watermark can become current. */
  public async applyChange(
    record: CompetitionRoutingRecord,
    change: CompetitionMigrationChangeEntity,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->applyChange`;
    ctx.timer?.start(timerName);
    try {
      const after = parseMigrationChangeImage(change.after_row),
        before = parseMigrationChangeImage(change.before_row);
      if (
        change.operation === 'UPDATE' &&
        before &&
        after &&
        ['drop_id', 'voter_id', 'decision_time'].some(
          (key) => before[key] !== after[key]
        )
      ) {
        await this.applyChange(
          record,
          { ...change, operation: 'DELETE', after_row: null },
          ctx
        );
      }
      const row = after ?? before;
      if (!row)
        throw new Error('OWNED_EXCEPTION: captured change has no source key');
      const table = change.source_table;
      if (isMigrationContentTable(table)) {
        await this.entry(record, String(row.drop_id), ctx);
        return;
      }
      const options = { wrappedConnection: ctx.connection };
      const params = { id: record.id, waveId: record.wave_id };
      switch (table) {
        case DROPS_TABLE:
          await this.replayDrop(record, String(row.id), ctx);
          break;
        case DROP_VOTER_STATE_TABLE:
        case DROPS_VOTES_CREDIT_SPENDINGS_TABLE:
          await this.vote(
            record,
            String(row.drop_id),
            String(row.voter_id),
            ctx
          );
          break;
        case DROP_RANK_TABLE:
        case WAVE_LEADERBOARD_ENTRIES_TABLE:
          await this.runtime(record, String(row.drop_id), ctx);
          break;
        case WAVES_TABLE:
        case WAVE_OUTCOMES_TABLE:
        case WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE:
        case WAVE_VOTING_CREDIT_NFTS_TABLE:
          await this.replayConfiguration(record, change, ctx);
          break;
        case WAVES_DECISION_PAUSES_TABLE:
          await this.db.execute(
            `delete from ${COMPETITION_PAUSES_TABLE} where competition_id=:id and id=:pauseId`,
            {
              ...params,
              pauseId: legacyCompetitionPauseId(record.id, String(row.id))
            },
            options
          );
          break; // The keyset pause stage copies the current row, if it survives.
        case WAVES_DECISIONS_TABLE:
        case WAVES_DECISION_WINNER_DROPS_TABLE:
          await this.replayDecision(record, Number(row.decision_time), ctx);
          break; // Awards and archives are refreshed by the remaining stages.
        case WINNER_DROP_VOTER_VOTES_TABLE:
          await this.db.execute(
            `delete from ${COMPETITION_WINNER_VOTES_TABLE} where competition_id=:id and entry_id=:entryId and voter_profile_id=:voter`,
            {
              ...params,
              entryId: legacyCompetitionEntryId(record.id, String(row.drop_id)),
              voter: String(row.voter_id)
            },
            options
          );
          break;
      }
      // Separate aggregate/voter time histories remain retained, immutable input
      // identities. Their captured before/after images remain in the durable journal.
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async replayDrop(
    record: CompetitionRoutingRecord,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->replayDrop`;
    ctx.timer?.start(timerName);
    try {
      const options = { wrappedConnection: ctx.connection };
      const params = { id: record.id, waveId: record.wave_id };
      const entryId = legacyCompetitionEntryId(record.id, dropId);
      const exists = await this.db.oneOrNull<{ id: string }>(
        `select id from ${DROPS_TABLE} where id=:dropId and wave_id=:waveId and drop_type in ('PARTICIPATORY','WINNER')`,
        { ...params, dropId },
        options
      );
      if (exists) {
        await this.entry(record, dropId, ctx);
        return;
      }
      for (const target of [
        COMPETITION_VOTES_TABLE,
        COMPETITION_LEADERBOARD_ENTRIES_TABLE,
        COMPETITION_ENTRY_RUNTIME_TABLE,
        COMPETITION_ENTRIES_TABLE
      ]) {
        const key = target === COMPETITION_ENTRIES_TABLE ? 'id' : 'entry_id';
        await this.db.execute(
          `delete from ${target} where competition_id=:id and ${key}=:entryId`,
          { ...params, entryId },
          options
        );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async replayConfiguration(
    record: CompetitionRoutingRecord,
    change: CompetitionMigrationChangeEntity,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->replayConfiguration`;
    ctx.timer?.start(timerName);
    try {
      const options = { wrappedConnection: ctx.connection };
      const params = { id: record.id, waveId: record.wave_id };
      const table = change.source_table;
      await this.batch(
        record,
        'CONFIGURATION',
        0,
        100,
        Number(change.occurred_at),
        null,
        ctx
      );
      if (
        table === WAVE_OUTCOMES_TABLE ||
        table === WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE
      ) {
        for (const target of [
          COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
          COMPETITION_OUTCOMES_TABLE
        ]) {
          await this.db.execute(
            `delete from ${target} where competition_id=:id`,
            params,
            options
          );
        }
        await this.batch(
          record,
          'OUTCOMES',
          0,
          100,
          Number(change.occurred_at),
          null,
          ctx
        );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async replayDecision(
    record: CompetitionRoutingRecord,
    decisionTime: number,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->replayDecision`;
    ctx.timer?.start(timerName);
    try {
      const options = { wrappedConnection: ctx.connection };
      const params = { id: record.id, waveId: record.wave_id };
      const decisionId = legacyCompetitionDecisionId(record.id, decisionTime);
      // Winner/archive copies are read-only; replay never publishes execution effects.
      for (const target of [
        COMPETITION_DECISION_WINNERS_TABLE,
        COMPETITION_OUTCOME_AWARDS_TABLE,
        COMPETITION_WINNER_VOTES_TABLE,
        COMPETITION_DECISIONS_TABLE
      ]) {
        const key =
          target === COMPETITION_DECISIONS_TABLE ? 'id' : 'decision_id';
        await this.db.execute(
          `delete from ${target} where competition_id=:id and ${key}=:decisionId`,
          { ...params, decisionId },
          options
        );
      }
      const current = await this.db.oneOrNull<{ decision_time: number }>(
        `select decision_time from ${WAVES_DECISIONS_TABLE} where wave_id=:waveId and decision_time=:time`,
        { ...params, time: decisionTime },
        options
      );
      if (current) await this.decision(record, decisionTime, ctx);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async outcomes(
    record: CompetitionRoutingRecord,
    reader: LegacyCompetitionAdapter,
    _offset: number,
    now: number,
    ctx: RequestContext
  ): Promise<number> {
    const timerName = `${this.constructor.name}->outcomes`;
    ctx.timer?.start(timerName);
    try {
      const legacy = {
        ...record,
        storage_mode: CompetitionStorageMode.LEGACY_ADAPTER
      };
      const outcomes = await collectCompetitionPages((page) =>
        reader.listOutcomes(legacy, page)
      );
      const definitions: object[] = [];
      for (const outcome of outcomes) {
        await this.upsert(
          COMPETITION_OUTCOMES_TABLE,
          [
            {
              ...outcome,
              created_at: Number(
                (await reader.getCompetition(legacy, now)).created_at
              )
            }
          ],
          ctx
        );
        const distribution = await collectCompetitionPages((page) =>
          reader.listDistribution(legacy, outcome.id, page)
        );
        await this.upsert(
          COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
          distribution.map((item) => ({
            ...item,
            competition_id: record.id
          })),
          ctx
        );
        definitions.push({
          type: outcome.type,
          subtype: outcome.subtype,
          description: outcome.description,
          credit: outcome.credit,
          rep_category: outcome.rep_category,
          amount: outcome.amount,
          distribution: distribution.map((item) => ({
            amount: item.amount,
            description: item.description
          }))
        });
      }
      await this.db.execute(
        `update ${COMPETITIONS_TABLE} set outcome_config=:definitions where id=:id`,
        { id: record.id, definitions: JSON.stringify(definitions) },
        { wrappedConnection: ctx.connection }
      );
      return 0;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async upsert(
    table: string,
    rows: readonly object[],
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->upsert`;
    ctx.timer?.start(timerName);
    try {
      for (const row of rows) {
        const values = Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value !== null && typeof value === 'object'
              ? JSON.stringify(value)
              : value
          ])
        );
        const columns = Object.keys(values);
        await this.db.execute(
          `insert into ${table} (${columns.map((column) => `\`${column}\``).join(',')}) values (${columns.map((column) => `:${column}`).join(',')}) on duplicate key update ${columns.map((column) => `\`${column}\` = values(\`${column}\`)`).join(',')}`,
          values,
          { wrappedConnection: ctx.connection }
        );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async batch(
    record: CompetitionRoutingRecord,
    stage: MigrationStage,
    offset: number,
    limit: number,
    now: number,
    cursor: string | null,
    ctx: RequestContext
  ): Promise<number | string> {
    const timerName = `${this.constructor.name}->batch`;
    ctx.timer?.start(timerName);
    try {
      if (!ctx.connection)
        throw new Error('Migration batch requires a transaction');
      const repository = new CompetitionRepository(() => this.db);
      const reader = new LegacyCompetitionAdapter(
        repository,
        new WavesApiDb(() => this.db),
        ctx
      );
      const legacy = {
        ...record,
        storage_mode: CompetitionStorageMode.LEGACY_ADAPTER
      };
      const page = { offset, limit, direction: 'ASC' as const };
      switch (stage) {
        case 'CONFIGURATION': {
          const c = await reader.getCompetition(legacy, now);
          await this.db.execute(
            `update ${COMPETITIONS_TABLE} set type=:type, lifecycle=:lifecycle, title=:title,
          participation_config=:participation, voting_config=:voting, decision_config=:decisions, winner_config=:winners,
          participation_starts_at=:participationStart, participation_ends_at=:participationEnd,
          voting_starts_at=:votingStart, voting_ends_at=:votingEnd, updated_at=:updatedAt, ended_at=:endedAt
          where id=:id and legacy_wave_id=:waveId`,
            {
              id: record.id,
              waveId: record.wave_id,
              type: c.type,
              lifecycle: c.lifecycle,
              title: c.title,
              participation: JSON.stringify(c.participation),
              voting: JSON.stringify(c.voting),
              decisions: JSON.stringify(c.decisions),
              winners: JSON.stringify(c.winners),
              participationStart: c.participation.starts_at,
              participationEnd: c.participation.ends_at,
              votingStart: c.voting.starts_at,
              votingEnd: c.voting.ends_at,
              updatedAt: c.updated_at,
              endedAt: c.ended_at
            },
            { wrappedConnection: ctx.connection }
          );
          return 0;
        }
        case 'OUTCOMES':
          return await this.outcomes(record, reader, offset, now, ctx);
        case 'ENTRIES': {
          const source = await this.entryKeys(record, offset, limit, ctx);
          await this.entryPage(
            record,
            source.map((row) => row.id),
            ctx
          );
          return source.length === limit
            ? Number(source[source.length - 1].serial_no)
            : 0;
        }
        case 'PAUSES': {
          const source = await this.db.execute<{
            id: number;
            start_time: number;
            end_time: number;
            reason: string | null;
          }>(
            `select id,start_time,end_time,reason from ${WAVES_DECISION_PAUSES_TABLE} where wave_id=:waveId and id>:offset order by id limit :limit`,
            { waveId: record.wave_id, offset, limit },
            { wrappedConnection: ctx.connection }
          );
          await this.upsert(
            COMPETITION_PAUSES_TABLE,
            source.map((row) => ({
              id: legacyCompetitionPauseId(record.id, row.id),
              legacy_source_id: Number(row.id),
              competition_id: record.id,
              start_time: Number(row.start_time),
              end_time: Number(row.end_time),
              reason: row.reason
            })),
            ctx
          );
          return source.length === limit
            ? Number(source[source.length - 1].id)
            : 0;
        }
        case 'DECISIONS':
          return this.decisionBatch(record, offset, limit, ctx);
        case 'VOTERS':
          return this.voters(record, limit, cursor, ctx);
        case 'VOTES':
          return this.votes(record, offset, limit, ctx);
        case 'LEADERBOARD':
          return this.leaderboard(record, offset, limit, ctx);
        case 'HISTORY':
          return this.history(record, limit, cursor, ctx);
        case 'ARCHIVE_VOTERS':
          return this.archiveVoters(record, limit, cursor, ctx);
        default:
          throw new Error('Unsupported migration stage');
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async decisionBatch(
    record: CompetitionRoutingRecord,
    offset: number,
    limit: number,
    ctx: RequestContext
  ): Promise<number> {
    const keys = await this.db.execute<{
      decision_time: number;
      winner_count: number;
    }>(
      `select d.decision_time,
        (select count(*) from ${WAVES_DECISION_WINNER_DROPS_TABLE} w where w.wave_id=d.wave_id and w.decision_time=d.decision_time) winner_count
       from ${WAVES_DECISIONS_TABLE} d where d.wave_id=:waveId and d.decision_time>:offset order by d.decision_time limit :limit`,
      { waveId: record.wave_id, offset, limit },
      { wrappedConnection: ctx.connection }
    );
    let copied = 0;
    let units = 0;
    // Keep one large winner set atomic, as before; otherwise share the
    // row budget between decisions and winners instead of waiting once
    // for every empty historical decision.
    for (const key of keys) {
      const cost = 1 + Number(key.winner_count);
      if (copied && units + cost > limit) break;
      await this.decision(record, Number(key.decision_time), ctx);
      copied++;
      units += cost;
    }
    return copied && (copied < keys.length || keys.length === limit)
      ? Number(keys[copied - 1].decision_time)
      : 0;
  }

  public async decision(
    record: CompetitionRoutingRecord,
    time: number,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->decision`;
    ctx.timer?.start(timerName);
    try {
      const repository = new CompetitionRepository(() => this.db);
      const count = await this.db.oneOrNull<{ count: number }>(
        `select count(*) as count from ${WAVES_DECISIONS_TABLE} where wave_id=:waveId and decision_time<:time`,
        { waveId: record.wave_id, time },
        { wrappedConnection: ctx.connection }
      );
      const decisions = await repository.listLegacyDecisions(
        record,
        { offset: Number(count?.count ?? 0), limit: 1, direction: 'ASC' },
        ctx
      );

      for (const decision of decisions.data) {
        const { winners, ...fields } = decision;
        const sourceWinners = winners.length
          ? await this.db.execute<{ drop_id: string }>(
              `select drop_id from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id=:waveId and decision_time=:time`,
              { waveId: record.wave_id, time: decision.scheduled_at },
              { wrappedConnection: ctx.connection }
            )
          : [];
        const dropIds = new Map(
          sourceWinners.map((winner) => [
            legacyCompetitionEntryId(record.id, winner.drop_id),
            winner.drop_id
          ])
        );
        await this.upsert(
          COMPETITION_DECISIONS_TABLE,
          [
            {
              ...fields,
              execution_key: `decision:${record.id}:${decision.scheduled_at}`,
              created_at: decision.decided_at ?? time
            }
          ],
          ctx
        );
        await this.upsert(
          COMPETITION_DECISION_WINNERS_TABLE,
          winners.map((winner) => ({
            ...winner,
            legacy_drop_id: dropIds.get(winner.entry_id),
            decision_id: decision.id,
            competition_id: record.id,
            created_at: decision.decided_at ?? time
          })),
          ctx
        );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async entryKeys(
    record: CompetitionRoutingRecord,
    offset: number,
    limit: number,
    ctx: RequestContext
  ) {
    const timerName = `${this.constructor.name}->entryKeys`;
    ctx.timer?.start(timerName);
    try {
      return this.db.execute<{ id: string; serial_no: number }>(
        `select id,serial_no from ${DROPS_TABLE} where wave_id=:waveId and drop_type in ('PARTICIPATORY','WINNER') and serial_no>:offset order by serial_no limit :limit`,
        { waveId: record.wave_id, offset, limit },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  private async entryPage(
    record: CompetitionRoutingRecord,
    dropIds: readonly string[],
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->entryPage`;
    ctx.timer?.start(timerName);
    try {
      if (record.storage_mode !== CompetitionStorageMode.LEGACY_ADAPTER)
        throw new Error('Migration entry pages require legacy ownership');
      if (!dropIds.length) return;
      const entries = await new CompetitionRepository(
        () => this.db
      ).findLegacyEntriesByDropIds(record, dropIds, ctx);
      const drops = await this.db.execute<DropEntity>(
        `select * from ${DROPS_TABLE} where id in (:dropIds) and wave_id=:waveId and drop_type in ('PARTICIPATORY','WINNER')`,
        { dropIds, waveId: record.wave_id },
        { wrappedConnection: ctx.connection }
      );
      if (entries.length !== dropIds.length || drops.length !== dropIds.length)
        throw new Error(
          'Migration entry source disappeared while ownership was locked'
        );
      await this.upsert(
        COMPETITION_ENTRIES_TABLE,
        entries.map((entry) => ({
          ...entry,
          withdrawn_at: null,
          disqualified_at: null
        })),
        ctx
      );
      const pages = new CompetitionMigrationContentRepository(() => this.db);
      const contents = await pages.sourcePage(drops, ctx);
      const previous = await pages.nativePage(
        record.id,
        entries.map((entry) => entry.id),
        ctx
      );
      const sourceDrops = new Map(drops.map((drop) => [drop.id, drop]));
      await readSequentially(entries, async (entry) => {
        const content = contents.get(entry.drop_id);
        const drop = sourceDrops.get(entry.drop_id);
        if (!content || !drop)
          throw new Error(
            'OWNED_EXCEPTION: migration entry content page is incomplete'
          );
        await this.saveEntryContent(
          entry,
          content,
          previous.get(entry.id) ?? null,
          drop,
          ctx
        );
      });
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  public async entry(
    record: CompetitionRoutingRecord,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->entry`;
    ctx.timer?.start(timerName);
    try {
      if (record.storage_mode === CompetitionStorageMode.NATIVE) {
        const current = await this.db.oneOrNull<{ status: string }>(
          `select status from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id and drop_id=:dropId for update`,
          { id: record.id, dropId },
          { wrappedConnection: ctx.connection }
        );
        // After transfer this adapter is used only for an accepted original
        // legacy create/edit. It cannot resurrect a terminal native entry.
        if (current && current.status !== 'ACTIVE')
          throw new Error(
            'OWNED_EXCEPTION: native entry state cannot be reset'
          );
      }
      const entry = await new CompetitionRepository(
        () => this.db
      ).findLegacyEntry(
        record,
        legacyCompetitionEntryId(record.id, dropId),
        ctx
      );
      if (entry) {
        await this.upsert(
          COMPETITION_ENTRIES_TABLE,
          [{ ...entry, withdrawn_at: null, disqualified_at: null }],
          ctx
        );
        const drop = await this.db.oneOrNull<DropEntity>(
          `select * from ${DROPS_TABLE} where id=:dropId`,
          { dropId },
          { wrappedConnection: ctx.connection }
        );
        if (!drop)
          throw new Error(
            'Migration entry source disappeared while ownership was locked'
          );
        const contents = new CompetitionEntryRepository(() => this.db),
          content = await contents.loadDropContent(drop, ctx),
          previous = await contents.getContent(entry.id, ctx);
        await this.saveEntryContent(entry, content, previous, drop, ctx);
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  private async saveEntryContent(
    entry: CompetitionEntry,
    content: CompetitionEntryContent,
    previous: CompetitionEntryContent | null,
    drop: DropEntity,
    ctx: RequestContext
  ): Promise<void> {
    if (competitionPayloadHash(previous) === competitionPayloadHash(content))
      return;
    await new CompetitionEntryRepository(() => this.db).saveContent(
      entry,
      content,
      entry.submitter_id,
      undefined,
      {
        ...ctx,
        competitionContentObservedAt: Number(drop.updated_at ?? drop.created_at)
      }
    );
  }
  private async voters(
    record: CompetitionRoutingRecord,
    limit: number,
    cursor: string | null,
    ctx: RequestContext
  ): Promise<number | string> {
    const timerName = `${this.constructor.name}->voters`;
    ctx.timer?.start(timerName);
    try {
      const [drop, voter] = cursor
        ? (JSON.parse(cursor) as string[])
        : ['', ''];
      const rows = await this.db.execute<{ drop_id: string; voter_id: string }>(
        `select drop_id,voter_id from ${DROP_VOTER_STATE_TABLE} where wave_id=:waveId and (drop_id>:drop or (drop_id=:drop and voter_id>:voter)) order by drop_id,voter_id limit :limit`,
        { waveId: record.wave_id, drop, voter, limit },
        { wrappedConnection: ctx.connection }
      );
      // A caller may checkpoint 100 keys, but each joined credit statement and
      // bulk write stays at the measured 25-key size within the same atomic batch.
      const pages = Array.from(
        { length: Math.ceil(rows.length / VOTER_COPY_QUERY_LIMIT) },
        (_, page) =>
          rows.slice(
            page * VOTER_COPY_QUERY_LIMIT,
            (page + 1) * VOTER_COPY_QUERY_LIMIT
          )
      );
      await readSequentially(pages, (keys) =>
        this.copyVoterPage(record, keys, ctx)
      );
      const last = rows[rows.length - 1];
      return rows.length === limit
        ? JSON.stringify([last.drop_id, last.voter_id])
        : 0;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  /** Read each credit history once and keep MySQL's source-key collation. The
   * raw key page, including orphan/ineligible parents, still owns the cursor. */
  private async copyVoterPage(
    record: CompetitionRoutingRecord,
    keys: readonly { drop_id: string; voter_id: string }[],
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->copyVoterPage`;
    ctx.timer?.start(timerName);
    try {
      if (!keys.length) return;
      const params: Record<string, string> = { waveId: record.wave_id };
      const predicate = keys
        .map((key, index) => {
          params[`drop${index}`] = key.drop_id;
          params[`voter${index}`] = key.voter_id;
          return `(s.drop_id=:drop${index} and s.voter_id=:voter${index})`;
        })
        .join(' or ');
      const rows = await this.db.execute<{
        drop_id: string;
        voter_id: string;
        votes: number;
        eligible: number;
        credit_spent: number;
        created_at: number | null;
      }>(
        `select s.drop_id,s.voter_id,s.votes,d.id is not null as eligible,
                coalesce(sum(c.credit_spent),0) as credit_spent,min(c.created_at) as created_at
         from ${DROP_VOTER_STATE_TABLE} s
         left join ${DROPS_TABLE} d on d.id=s.drop_id and d.drop_type in ('PARTICIPATORY','WINNER'${record.storage_mode === CompetitionStorageMode.NATIVE ? ",'COMPETITION'" : ''})
         left join ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} c
           on c.wave_id=s.wave_id and c.drop_id=s.drop_id and c.voter_id=s.voter_id and d.id is not null
         where s.wave_id=:waveId and (${predicate})
         group by s.drop_id,s.voter_id,s.votes,d.id`,
        params,
        { wrappedConnection: ctx.connection }
      );
      // The caller holds ownership and one repeatable-read source snapshot.
      if (rows.length !== keys.length)
        throw new Error('OWNED_EXCEPTION: incomplete voter copy page');
      const votes = rows
        .filter((row) => row.eligible)
        .map((row) => ({
          id: stableUuid(record.id, `vote:${row.drop_id}:${row.voter_id}`),
          competition_id: record.id,
          entry_id: legacyCompetitionEntryId(record.id, row.drop_id),
          voter_profile_id: row.voter_id,
          value: Number(row.votes),
          credit_spent: Number(row.credit_spent),
          created_at: Number(row.created_at ?? 0),
          updated_at: Number(row.created_at ?? 0)
        }));
      if (votes.length) {
        const columns = Object.keys(votes[0]);
        await this.db.bulkUpsert(
          COMPETITION_VOTES_TABLE,
          votes,
          columns,
          columns,
          ctx
        );
      }
      const missing = rows.filter((row) => !row.eligible);
      if (missing.length) {
        const deleteParams: Record<string, string> = { id: record.id };
        const deletes = missing.map((row, index) => {
          deleteParams[`entry${index}`] = legacyCompetitionEntryId(
            record.id,
            row.drop_id
          );
          deleteParams[`voter${index}`] = row.voter_id;
          return `(entry_id=:entry${index} and voter_profile_id=:voter${index})`;
        });
        await this.db.execute(
          `delete from ${COMPETITION_VOTES_TABLE} where competition_id=:id and (${deletes.join(' or ')})`,
          deleteParams,
          { wrappedConnection: ctx.connection }
        );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  public async vote(
    record: CompetitionRoutingRecord,
    dropId: string,
    voterId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->vote`;
    ctx.timer?.start(timerName);
    try {
      const entryId = legacyCompetitionEntryId(record.id, dropId);
      const row = await this.db.oneOrNull<{
        votes: number;
        credit_spent: number;
        created_at: number | null;
      }>(
        `select s.votes,(select coalesce(sum(credit_spent),0) from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} where wave_id=s.wave_id and drop_id=s.drop_id and voter_id=s.voter_id) as credit_spent,(select min(created_at) from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} where wave_id=s.wave_id and drop_id=s.drop_id and voter_id=s.voter_id) as created_at from ${DROP_VOTER_STATE_TABLE} s join ${DROPS_TABLE} d on d.id=s.drop_id and d.drop_type in ('PARTICIPATORY','WINNER'${record.storage_mode === CompetitionStorageMode.NATIVE ? ",'COMPETITION'" : ''}) where s.wave_id=:waveId and s.drop_id=:dropId and s.voter_id=:voterId`,
        { waveId: record.wave_id, dropId, voterId },
        { wrappedConnection: ctx.connection }
      );
      if (!row) {
        await this.db.execute(
          `delete from ${COMPETITION_VOTES_TABLE} where competition_id=:id and entry_id=:entryId and voter_profile_id=:voterId`,
          { id: record.id, entryId, voterId },
          { wrappedConnection: ctx.connection }
        );
        return;
      }
      const at = Number(row.created_at ?? 0);
      await this.upsert(
        COMPETITION_VOTES_TABLE,
        [
          {
            id: stableUuid(record.id, `vote:${dropId}:${voterId}`),
            competition_id: record.id,
            entry_id: entryId,
            voter_profile_id: voterId,
            value: Number(row.votes),
            credit_spent: Number(row.credit_spent),
            created_at: at,
            updated_at: at
          }
        ],
        ctx
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  private async votes(
    record: CompetitionRoutingRecord,
    offset: number,
    limit: number,
    ctx: RequestContext
  ): Promise<number> {
    const timerName = `${this.constructor.name}->votes`;
    ctx.timer?.start(timerName);
    try {
      const source = await this.entryKeys(record, offset, limit, ctx);
      for (const row of source) await this.runtime(record, row.id, ctx);
      return source.length === limit
        ? Number(source[source.length - 1].serial_no)
        : 0;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  public async runtime(
    record: CompetitionRoutingRecord,
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->runtime`;
    ctx.timer?.start(timerName);
    try {
      const [row] = await this.db.execute<{
        created_at: number;
        vote: number;
        last_increased: number | null;
        over_threshold_since_ms: number | null;
      }>(
        `select d.created_at,coalesce(r.vote,0) as vote,r.last_increased,l.over_threshold_since_ms from ${DROPS_TABLE} d left join ${DROP_RANK_TABLE} r on r.drop_id=d.id left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} l on l.wave_id=d.wave_id and l.drop_id=d.id where d.id=:dropId and d.wave_id=:waveId and d.drop_type in ('PARTICIPATORY','WINNER')`,
        { dropId, waveId: record.wave_id },
        { wrappedConnection: ctx.connection }
      );
      if (!row) return;
      await this.upsert(
        COMPETITION_ENTRY_RUNTIME_TABLE,
        [
          {
            competition_id: record.id,
            entry_id: legacyCompetitionEntryId(record.id, dropId),
            real_time_rating: Number(row.vote),
            last_increased_at: row.last_increased,
            over_threshold_since: row.over_threshold_since_ms,
            updated_at: Number(row.last_increased ?? row.created_at)
          }
        ],
        ctx
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  private async refreshEntryRanks(
    record: CompetitionRoutingRecord,
    rows: readonly { drop_id: string; entry_rank: number }[],
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->refreshEntryRanks`;
    ctx.timer?.start(timerName);
    try {
      if (!rows.length) return;
      const entries = rows.map((row) =>
        legacyCompetitionEntryId(record.id, row.drop_id)
      );
      const params: Record<string, unknown> = { id: record.id, entries };
      const cases = rows.map((row, index) => {
        params[`entry${index}`] = entries[index];
        params[`rank${index}`] = Number(row.entry_rank);
        return `when :entry${index} then :rank${index}`;
      });
      await this.db.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set \`rank\`=case id ${cases.join(' ')} else \`rank\` end where competition_id=:id and id in (:entries)`,
        params,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async leaderboard(
    record: CompetitionRoutingRecord,
    offset: number,
    limit: number,
    ctx: RequestContext
  ): Promise<number> {
    const timerName = `${this.constructor.name}->leaderboard`;
    ctx.timer?.start(timerName);
    try {
      const rows = await this.db.execute<{
        drop_id: string;
        drop_type: DropType;
        serial_no: number;
        submitted_at: number;
        rating: number;
        real_time_rating: number;
        competition_rank: number;
        entry_rank: number;
        ordering_time: number;
        decision_rating: number;
      }>(
        `with source as (select d.id as drop_id,d.drop_type,d.serial_no,d.created_at as submitted_at,
       cast(if(w.time_lock_ms>0,coalesce(l.vote,0),coalesce(r.vote,0)) as signed) as rating,cast(coalesce(r.vote,0) as signed) as real_time_rating,
       if(w.time_lock_ms>0,coalesce(l.timestamp,d.created_at),coalesce(r.last_increased,d.created_at)) as tie_time,
       coalesce(r.last_increased,d.created_at) as live_tie_time,
       coalesce(l.timestamp,d.created_at) as ordering_time,coalesce(l.vote_on_decision_time,coalesce(r.vote,0)) as decision_rating
       from ${DROPS_TABLE} d join ${WAVES_TABLE} w on w.id=d.wave_id left join ${DROP_RANK_TABLE} r on r.drop_id=d.id left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} l on l.wave_id=d.wave_id and l.drop_id=d.id where d.wave_id=:waveId and d.drop_type in ('PARTICIPATORY','WINNER')),
       live_ranked as (select source.*,rank() over(order by real_time_rating desc,live_tie_time asc) as live_rank from source),
       leaderboard_ranked as (select drop_id,rank() over(order by rating desc,tie_time asc) as competition_rank from source where drop_type='PARTICIPATORY'),
       latest_winners as (select drop_id,ranking,row_number() over(partition by drop_id order by decision_time desc,ranking asc) as winner_order from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id=:waveId)
       select live_ranked.*,leaderboard_ranked.competition_rank,coalesce(latest_winners.ranking,live_ranked.live_rank) as entry_rank
       from live_ranked left join leaderboard_ranked on leaderboard_ranked.drop_id=live_ranked.drop_id
       left join latest_winners on latest_winners.drop_id=live_ranked.drop_id and latest_winners.winner_order=1
       where serial_no>:offset order by serial_no limit :limit`,
        { waveId: record.wave_id, offset, limit },
        { wrappedConnection: ctx.connection }
      );
      // Entry lists use live ranks across all legacy entries; the leaderboard
      // uses active entries and may expose a separately locked snapshot.
      // Refresh both projections before acknowledging this journal window.
      await this.refreshEntryRanks(record, rows, ctx);
      // A legacy decision can turn a previously copied active entry into a
      // winner. Upserting only current active rows would leave its old cached
      // leaderboard row behind. Remove that projection, retaining the entry,
      // winner, votes and history in this same checkpoint transaction.
      await readSequentially(
        collections.chunkArray(
          rows
            .filter((row) => row.drop_type === DropType.WINNER)
            .map((row) => legacyCompetitionEntryId(record.id, row.drop_id)),
          LEADERBOARD_CLEANUP_QUERY_LIMIT
        ),
        async (entries) => {
          await this.db.execute(
            `delete from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id and entry_id in (:entries)`,
            { id: record.id, entries },
            { wrappedConnection: ctx.connection }
          );
        }
      );
      await this.upsert(
        COMPETITION_LEADERBOARD_ENTRIES_TABLE,
        rows
          .filter((row) => row.drop_type === DropType.PARTICIPATORY)
          .map((row) => ({
            competition_id: record.id,
            entry_id: legacyCompetitionEntryId(record.id, row.drop_id),
            drop_id: row.drop_id,
            rating: Number(row.rating),
            real_time_rating: Number(row.real_time_rating),
            rank: Number(row.competition_rank),
            submitted_at: Number(row.submitted_at),
            updated_at: Number(row.submitted_at),
            ordering_time: Number(row.ordering_time),
            decision_rating: Number(row.decision_rating)
          })),
        ctx
      );
      return rows.length === limit
        ? Number(rows[rows.length - 1].serial_no)
        : 0;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async history(
    record: CompetitionRoutingRecord,
    limit: number,
    cursor: string | null,
    ctx: RequestContext
  ): Promise<number | string> {
    const timerName = `${this.constructor.name}->history`;
    ctx.timer?.start(timerName);
    try {
      const [time, dropId] = cursor
        ? (JSON.parse(cursor) as [number, string])
        : [-1, ''];
      const winners = await this.db.execute<{
        drop_id: string;
        decision_time: number;
        prizes: string | readonly Record<string, unknown>[];
      }>(
        `select drop_id,decision_time,prizes from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id=:waveId and (decision_time>:time or (decision_time=:time and drop_id>:dropId)) order by decision_time,drop_id limit :limit`,
        { waveId: record.wave_id, time, dropId, limit: 1 },
        { wrappedConnection: ctx.connection }
      );
      for (const winner of winners) {
        const decisionId = legacyCompetitionDecisionId(
          record.id,
          Number(winner.decision_time)
        );
        const entryId = legacyCompetitionEntryId(record.id, winner.drop_id);
        const prizes =
          typeof winner.prizes === 'string'
            ? (JSON.parse(winner.prizes) as Record<string, unknown>[])
            : winner.prizes;
        await this.upsert(
          COMPETITION_OUTCOME_AWARDS_TABLE,
          prizes.map((award, position) => ({
            id: stableUuid(decisionId, `award:${entryId}:${position}`),
            competition_id: record.id,
            decision_id: decisionId,
            entry_id: entryId,
            outcome_position: position,
            award,
            created_at: Number(winner.decision_time)
          })),
          ctx
        );
      }
      const last = winners[winners.length - 1];
      return winners.length === 1
        ? JSON.stringify([Number(last.decision_time), last.drop_id])
        : 0;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
  private async archiveVoters(
    record: CompetitionRoutingRecord,
    limit: number,
    cursor: string | null,
    ctx: RequestContext
  ): Promise<number | string> {
    const timerName = `${this.constructor.name}->archiveVoters`;
    ctx.timer?.start(timerName);
    try {
      const ambiguous = await this.db.oneOrNull<{ drop_id: string }>(
        `select drop_id from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id=:waveId group by drop_id having count(*)>1 limit 1`,
        { waveId: record.wave_id },
        { wrappedConnection: ctx.connection }
      );
      if (ambiguous)
        throw new Error(
          'OWNED_EXCEPTION: historical winner identity requires a reviewed mapping'
        );

      const [drop, voter] = cursor
        ? (JSON.parse(cursor) as string[])
        : ['', ''];
      const rows = await this.db.execute<{
        drop_id: string;
        voter_id: string;
        votes: number;
        decision_time: number;
      }>(
        `select v.drop_id,v.voter_id,v.votes,w.decision_time from ${WINNER_DROP_VOTER_VOTES_TABLE} v join ${WAVES_DECISION_WINNER_DROPS_TABLE} w on w.wave_id=v.wave_id and w.drop_id=v.drop_id where v.wave_id=:waveId and (v.drop_id>:drop or (v.drop_id=:drop and v.voter_id>:voter)) order by v.drop_id,v.voter_id limit :limit`,
        { waveId: record.wave_id, drop, voter, limit },
        { wrappedConnection: ctx.connection }
      );
      await this.upsert(
        COMPETITION_WINNER_VOTES_TABLE,
        rows.map((row) => ({
          competition_id: record.id,
          decision_id: legacyCompetitionDecisionId(
            record.id,
            Number(row.decision_time)
          ),
          entry_id: legacyCompetitionEntryId(record.id, row.drop_id),
          voter_profile_id: row.voter_id,
          value: Number(row.votes)
        })),
        ctx
      );
      const last = rows[rows.length - 1];
      return rows.length === limit
        ? JSON.stringify([last.drop_id, last.voter_id])
        : 0;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}
