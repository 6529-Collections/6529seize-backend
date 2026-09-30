import { randomUUID } from 'node:crypto';
import { stableUuid } from './competition-id';
import {
  COMPETITION_COMMANDS_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_SIGNATURE_NONCES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  CompetitionEntity,
  CompetitionLifecycle
} from '@/entities/ICompetition';
import { CustomApiCompliantException, NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { CompetitionRecord } from '@/competitions/competition.repository';
import { competitionPayloadHash } from '@/competitions/competition-command-identity';

export function competitionConflict(message: string): never {
  throw new CustomApiCompliantException(409, message);
}

function options(ctx: RequestContext) {
  if (!ctx.connection)
    throw new Error('Competition command requires a transaction');
  return { wrappedConnection: ctx.connection };
}

export class CompetitionCommandRepository extends LazyDbAccessCompatibleService {
  private async timed<T>(
    operation: string,
    ctx: RequestContext,
    execute: () => Promise<T>
  ): Promise<T> {
    const name = `${this.constructor.name}->${operation}`;
    ctx.timer?.start(name);
    try {
      return await execute();
    } finally {
      ctx.timer?.stop(name);
    }
  }

  public async findSavedCommand<T>(
    actorId: string,
    idempotencyKey: string,
    payload: unknown,
    ctx: RequestContext
  ): Promise<T | null> {
    const timerName = `${this.constructor.name}->findSavedCommand`;
    ctx.timer?.start(timerName);
    try {
      const row = await this.db.oneOrNull<{
        payload_hash: string;
        result: string | T | null;
      }>(
        `select payload_hash,result from ${COMPETITION_COMMANDS_TABLE} where id=:id`,
        { id: competitionPayloadHash([actorId, idempotencyKey]) },
        { wrappedConnection: ctx.connection }
      );
      if (!row) return null;
      if (row.payload_hash !== competitionPayloadHash(payload))
        competitionConflict('Idempotency key was used for another request');
      return typeof row.result === 'string'
        ? (JSON.parse(row.result) as T)
        : row.result;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async command<T>(
    actorId: string,
    idempotencyKey: string,
    payload: unknown,
    execute: (ctx: RequestContext) => Promise<T>,
    ctx: RequestContext
  ): Promise<T> {
    const timerName = `${this.constructor.name}->command`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.executeNativeQueriesInTransaction(
        async (connection) => {
          const tx = { ...ctx, connection };
          const id = competitionPayloadHash([actorId, idempotencyKey]);
          const payloadHash = competitionPayloadHash(payload);
          await this.db.execute(
            `INSERT INTO ${COMPETITION_COMMANDS_TABLE} (id, actor_id, payload_hash, result, created_at)
           VALUES (:id, :actorId, :payloadHash, NULL, :now)
           ON DUPLICATE KEY UPDATE id = id`,
            { id, actorId, payloadHash, now: Date.now() },
            options(tx)
          );
          const existing = await this.db.oneOrNull<{
            payload_hash: string;
            result: string | T | null;
          }>(
            `SELECT payload_hash, result FROM ${COMPETITION_COMMANDS_TABLE} WHERE id = :id FOR UPDATE`,
            { id },
            options(tx)
          );
          if (existing?.payload_hash !== payloadHash)
            competitionConflict('Idempotency key was used for another request');
          if (existing.result !== null) {
            return typeof existing.result === 'string'
              ? (JSON.parse(existing.result) as T)
              : existing.result;
          }
          const result = await execute(tx);
          await this.db.execute(
            `UPDATE ${COMPETITION_COMMANDS_TABLE} SET result = :result WHERE id = :id`,
            { id, result: JSON.stringify(result) },
            options(tx)
          );
          return result;
        },
        { isolationLevel: 'READ COMMITTED' }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async lockCompetition(
    waveId: string,
    competitionId: string,
    ctx: RequestContext
  ): Promise<CompetitionRecord> {
    return this.timed('lockCompetition', ctx, async () => {
      const row = await this.db.oneOrNull<CompetitionRecord>(
        `SELECT * FROM ${COMPETITIONS_TABLE} WHERE id = :competitionId AND wave_id = :waveId FOR UPDATE`,
        { competitionId, waveId },
        options(ctx)
      );
      if (!row) throw new NotFoundException('Competition not found');
      return row;
    });
  }

  public async lockWave(waveId: string, ctx: RequestContext): Promise<void> {
    return this.timed('lockWave', ctx, async () => {
      const wave = await this.db.oneOrNull<{ id: string }>(
        `SELECT id FROM ${WAVES_TABLE} WHERE id = :waveId FOR UPDATE`,
        { waveId },
        options(ctx)
      );
      if (!wave) throw new NotFoundException('Wave not found');
    });
  }

  public async lockDrop(dropId: string, ctx: RequestContext): Promise<void> {
    return this.timed('lockDrop', ctx, async () => {
      const drop = await this.db.oneOrNull<{ id: string }>(
        `SELECT id FROM ${DROPS_TABLE} WHERE id = :dropId FOR UPDATE`,
        { dropId },
        options(ctx)
      );
      if (!drop) throw new NotFoundException('Drop not found');
    });
  }

  public async saveCompetition(
    record: CompetitionEntity,
    actorId: string,
    versionConfig: unknown,
    ctx: RequestContext
  ): Promise<void> {
    return this.timed('saveCompetition', ctx, async () => {
      const columns = Object.keys(record);
      const jsonColumns = new Set([
        'participation_config',
        'voting_config',
        'decision_config',
        'winner_config',
        'outcome_config',
        'presentation_config'
      ]);
      const params = Object.fromEntries(
        Object.entries(record).map(([key, value]) => [
          key,
          jsonColumns.has(key) ? JSON.stringify(value) : value
        ])
      );
      await this.db.execute(
        `INSERT INTO ${COMPETITIONS_TABLE} (${columns.join(',')}) VALUES (${columns.map((key) => `:${key}`).join(',')})
       ON DUPLICATE KEY UPDATE ${columns
         .filter(
           (key) =>
             ![
               'id',
               'wave_id',
               'legacy_wave_id',
               'storage_mode',
               'created_at'
             ].includes(key)
         )
         .map((key) => `${key} = VALUES(${key})`)
         .join(',')}`,
        params,
        options(ctx)
      );
      await this.db.execute(
        `INSERT INTO ${COMPETITION_CONFIG_VERSIONS_TABLE} (competition_id, version, config, created_by, created_at)
       VALUES (:id, :version, :config, :actorId, :now)`,
        {
          id: record.id,
          version: record.config_version,
          config: JSON.stringify(versionConfig),
          actorId,
          now: record.updated_at
        },
        options(ctx)
      );
    });
  }

  public async getConfiguration<T>(
    competitionId: string,
    version: number,
    ctx: RequestContext
  ): Promise<T> {
    return this.timed('getConfiguration', ctx, async () => {
      const row = await this.db.oneOrNull<{ config: T | string }>(
        `SELECT config FROM ${COMPETITION_CONFIG_VERSIONS_TABLE} WHERE competition_id = :competitionId AND version = :version`,
        { competitionId, version },
        { wrappedConnection: ctx.connection }
      );
      if (!row)
        throw new NotFoundException('Competition configuration not found');
      return typeof row.config === 'string'
        ? (JSON.parse(row.config) as T)
        : row.config;
    });
  }

  public async hasActivity(
    competitionId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    return this.timed('hasActivity', ctx, async () => {
      const row = await this.db.oneOrNull<{ id: string }>(
        `SELECT id FROM ${COMPETITION_ENTRIES_TABLE} WHERE competition_id = :competitionId LIMIT 1`,
        { competitionId },
        options(ctx)
      );
      return row !== null;
    });
  }

  public async recordLifecycle(
    record: Pick<CompetitionEntity, 'id' | 'wave_id' | 'lifecycle'>,
    previous: CompetitionLifecycle | null,
    actorId: string,
    reason: string | null,
    ctx: RequestContext
  ): Promise<void> {
    return this.timed('recordLifecycle', ctx, async () => {
      await this.db.execute(
        `INSERT INTO ${COMPETITION_LIFECYCLE_EVENTS_TABLE} (id, competition_id, wave_id, previous_lifecycle, lifecycle, actor_id, reason, created_at)
       VALUES (:id, :competitionId, :waveId, :previous, :lifecycle, :actorId, :reason, :now)`,
        {
          id: randomUUID(),
          competitionId: record.id,
          waveId: record.wave_id,
          previous,
          lifecycle: record.lifecycle,
          actorId,
          reason,
          now: Date.now()
        },
        options(ctx)
      );
    });
  }

  public async consumeNonce(
    competitionId: string,
    actorId: string,
    action: string,
    nonce: string,
    ctx: RequestContext
  ): Promise<void> {
    return this.timed('consumeNonce', ctx, async () => {
      const id = competitionPayloadHash([
        competitionId,
        actorId,
        action,
        nonce
      ]);
      const previous = await this.db.oneOrNull<{ id: string }>(
        `SELECT id FROM ${COMPETITION_SIGNATURE_NONCES_TABLE} WHERE id = :id`,
        { id },
        options(ctx)
      );
      if (previous) competitionConflict('Signature nonce already consumed');
      await this.db.execute(
        `INSERT INTO ${COMPETITION_SIGNATURE_NONCES_TABLE} (id, competition_id, actor_id, consumed_at) VALUES (:id, :competitionId, :actorId, :now)`,
        { id, competitionId, actorId, now: Date.now() },
        options(ctx)
      );
    });
  }

  public async replaceOutcomeDefinitions(
    competitionId: string,
    outcomes: readonly {
      type: string;
      subtype?: string | null;
      description: string;
      credit?: string | null;
      rep_category?: string | null;
      amount?: number | null;
      distribution?: readonly {
        amount?: number | null;
        description?: string | null;
      }[];
    }[],
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    return this.timed('replaceOutcomeDefinitions', ctx, async () => {
      await this.db.execute(
        `DELETE FROM ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE} WHERE competition_id = :competitionId`,
        { competitionId },
        options(ctx)
      );
      await this.db.execute(
        `DELETE FROM ${COMPETITION_OUTCOMES_TABLE} WHERE competition_id = :competitionId`,
        { competitionId },
        options(ctx)
      );
      for (let index = 0; index < outcomes.length; index++) {
        const outcome = outcomes[index];
        const id = stableUuid(competitionId, `outcome-definition:${index + 1}`);
        await this.db.execute(
          `INSERT INTO ${COMPETITION_OUTCOMES_TABLE}
        (id,competition_id,decision_id,position,legacy_index,type,subtype,description,credit,rep_category,amount,created_at)
        VALUES (:id,:competitionId,NULL,:position,NULL,:type,:subtype,:description,:credit,:category,:amount,:now)`,
          {
            id,
            competitionId,
            position: index + 1,
            type: outcome.type,
            subtype: outcome.subtype ?? null,
            description: outcome.description,
            credit: outcome.credit ?? null,
            category: outcome.rep_category ?? null,
            amount: outcome.amount ?? null,
            now
          },
          options(ctx)
        );
        for (
          let itemIndex = 0;
          itemIndex < (outcome.distribution?.length ?? 0);
          itemIndex++
        ) {
          const item = outcome.distribution![itemIndex];
          await this.db.execute(
            `INSERT INTO ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE}
          (id,competition_id,outcome_id,position,amount,description) VALUES (:id,:competitionId,:outcomeId,:position,:amount,:description)`,
            {
              id: stableUuid(id, `distribution:${itemIndex + 1}`),
              competitionId,
              outcomeId: id,
              position: itemIndex + 1,
              amount: item.amount ?? null,
              description: item.description ?? null
            },
            options(ctx)
          );
        }
      }
    });
  }

  public async pause(
    competitionId: string,
    startsAt: number,
    endsAt: number | null,
    reason: string | null,
    ctx: RequestContext
  ): Promise<void> {
    return this.timed('pause', ctx, async () => {
      const overlapping = await this.db.oneOrNull<{ id: string }>(
        `SELECT id FROM ${COMPETITION_PAUSES_TABLE} WHERE competition_id = :competitionId
       AND (end_time IS NULL OR end_time >= :startsAt) AND (:endsAt IS NULL OR start_time <= :endsAt) LIMIT 1`,
        { competitionId, startsAt, endsAt },
        options(ctx)
      );
      if (overlapping)
        competitionConflict('A decision pause already covers this interval');
      await this.db.execute(
        `INSERT INTO ${COMPETITION_PAUSES_TABLE} (id,competition_id,start_time,end_time,reason) VALUES (:id,:competitionId,:startsAt,:endsAt,:reason)`,
        { id: randomUUID(), competitionId, startsAt, endsAt, reason },
        options(ctx)
      );
    });
  }

  public async resume(
    competitionId: string,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    return this.timed('resume', ctx, async () => {
      const pause = await this.db.oneOrNull<{ id: string }>(
        `SELECT id FROM ${COMPETITION_PAUSES_TABLE} WHERE competition_id = :competitionId AND start_time <= :now AND (end_time IS NULL OR end_time > :now) LIMIT 1`,
        { competitionId, now },
        options(ctx)
      );
      if (!pause) competitionConflict('There is no active decision pause');
      await this.db.execute(
        `UPDATE ${COMPETITION_PAUSES_TABLE} SET end_time = :now WHERE id = :id`,
        { id: pause.id, now },
        options(ctx)
      );
    });
  }
}

export const competitionCommandRepository = new CompetitionCommandRepository(
  dbSupplier
);
