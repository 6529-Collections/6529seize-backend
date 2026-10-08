import { isMigrationContentTable } from '@/competitions/competition-migration-capture';
import { CompetitionEntryRepository } from './competition-entry.repository';
import { DropEntity } from '@/entities/IDrop';
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
          break; // Decisions, awards and archives are recopied by keyset stages.
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
          const count = await this.db.oneOrNull<{ count: number }>(
            `select count(*) as count from ${target} where competition_id=:id`,
            params,
            options
          );
          if (Number(count?.count ?? 0) > 1000)
            throw new Error(
              'OWNED_EXCEPTION: outcome replay exceeds bounded cohort'
            );
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
        const count = await this.db.oneOrNull<{ count: number }>(
          `select count(*) as count from ${target} where competition_id=:id and ${key}=:decisionId`,
          { ...params, decisionId },
          options
        );
        if (Number(count?.count ?? 0) > 1000)
          throw new Error(
            'OWNED_EXCEPTION: decision replay exceeds bounded cohort'
          );
        await this.db.execute(
          `delete from ${target} where competition_id=:id and ${key}=:decisionId`,
          { ...params, decisionId },
          options
        );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async outcomes(
    record: CompetitionRoutingRecord,
    reader: LegacyCompetitionAdapter,
    offset: number,
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
      const page = { offset, limit: 100, direction: 'ASC' as const };
      const outcomes = await reader.listOutcomes(legacy, {
        ...page,
        limit: 100
      });
      const totalDistribution = await this.db.oneOrNull<{ count: number }>(
        `select count(*) as count from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id=:waveId`,
        { waveId: record.wave_id },
        { wrappedConnection: ctx.connection }
      );
      if (Number(totalDistribution?.count ?? 0) > 100)
        throw new Error(
          'OWNED_EXCEPTION: outcome distribution exceeds bounded ordinary cohort'
        );
      const definitions: object[] = [];
      for (const outcome of outcomes.data) {
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
        const distribution = await reader.listDistribution(legacy, outcome.id, {
          offset: 0,
          limit: 100,
          direction: 'ASC'
        });
        if (distribution.has_more)
          throw new Error(
            'OWNED_EXCEPTION: outcome distribution exceeds 100; preserve legacy ownership'
          );
        await this.upsert(
          COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
          distribution.data.map((item) => ({
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
          distribution: distribution.data.map((item) => ({
            amount: item.amount,
            description: item.description
          }))
        });
      }
      if (offset === 0 && !outcomes.has_more)
        await this.db.execute(
          `update ${COMPETITIONS_TABLE} set outcome_config=:definitions where id=:id`,
          { id: record.id, definitions: JSON.stringify(definitions) },
          { wrappedConnection: ctx.connection }
        );
      if (outcomes.has_more || offset !== 0)
        throw new Error(
          'OWNED_EXCEPTION: outcome configuration exceeds one bounded page'
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
          for (const row of source) await this.entry(record, row.id, ctx);
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
        case 'DECISIONS': {
          const keys = await this.db.execute<{ decision_time: number }>(
            `select decision_time from ${WAVES_DECISIONS_TABLE} where wave_id=:waveId and decision_time>:offset order by decision_time limit :limit`,
            { waveId: record.wave_id, offset, limit: 1 },
            { wrappedConnection: ctx.connection }
          );
          for (const key of keys)
            await this.decision(record, Number(key.decision_time), ctx);
          return keys.length === 1
            ? Number(keys[keys.length - 1].decision_time)
            : 0;
        }
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
      const winnerCount = await this.db.oneOrNull<{ count: number }>(
        `select count(*) as count from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id=:waveId and decision_time=:time`,
        { waveId: record.wave_id, time },
        { wrappedConnection: ctx.connection }
      );
      if (Number(winnerCount?.count ?? 0) > 100)
        throw new Error(
          'OWNED_EXCEPTION: decision winner fanout exceeds bounded ordinary cohort'
        );
      const decisions = await repository.listLegacyDecisions(
        record,
        { offset: Number(count?.count ?? 0), limit: 1, direction: 'ASC' },
        ctx
      );

      for (const decision of decisions.data) {
        const { winners, ...fields } = decision;
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
        if (
          competitionPayloadHash(previous) !== competitionPayloadHash(content)
        )
          await contents.saveContent(
            entry,
            content,
            entry.submitter_id,
            undefined,
            {
              ...ctx,
              competitionContentObservedAt: Number(
                drop.updated_at ?? drop.created_at
              )
            }
          );
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
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
      for (const row of rows)
        await this.vote(record, row.drop_id, row.voter_id, ctx);
      const last = rows[rows.length - 1];
      return rows.length === limit
        ? JSON.stringify([last.drop_id, last.voter_id])
        : 0;
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
        serial_no: number;
        submitted_at: number;
        rating: number;
        real_time_rating: number;
        competition_rank: number;
        ordering_time: number;
        decision_rating: number;
      }>(
        `with source as (select d.id as drop_id,d.serial_no,d.created_at as submitted_at,
       if(w.time_lock_ms>0,coalesce(l.vote,0),coalesce(r.vote,0)) as rating,coalesce(r.vote,0) as real_time_rating,
       if(w.time_lock_ms>0,coalesce(l.timestamp,d.created_at),coalesce(r.last_increased,d.created_at)) as tie_time,
       coalesce(l.timestamp,d.created_at) as ordering_time,coalesce(l.vote_on_decision_time,coalesce(r.vote,0)) as decision_rating
       from ${DROPS_TABLE} d join ${WAVES_TABLE} w on w.id=d.wave_id left join ${DROP_RANK_TABLE} r on r.drop_id=d.id left join ${WAVE_LEADERBOARD_ENTRIES_TABLE} l on l.wave_id=d.wave_id and l.drop_id=d.id where d.wave_id=:waveId and d.drop_type='PARTICIPATORY'),
       ranked as (select source.*,rank() over(order by rating desc,tie_time asc) as competition_rank from source)
       select * from ranked where serial_no>:offset order by serial_no limit :limit`,
        { waveId: record.wave_id, offset, limit },
        { wrappedConnection: ctx.connection }
      );
      await this.upsert(
        COMPETITION_LEADERBOARD_ENTRIES_TABLE,
        rows.map((row) => ({
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
        if (prizes.length > 100)
          throw new Error(
            'OWNED_EXCEPTION: award fanout exceeds bounded ordinary cohort'
          );
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
