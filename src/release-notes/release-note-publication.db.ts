import {
  DROP_METADATA_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  RELEASE_NOTE_PUBLICATIONS_TABLE,
  RELEASE_NOTE_STREAM_STATES_TABLE
} from '@/constants';
import type { ReleaseNoteDropReference } from '@/drops/drops.db';
import {
  ReleaseNotePublicationEntity,
  ReleaseNotePublicationStatus
} from '@/entities/IReleaseNotePublication';
import { ReleaseNoteStreamStateEntity } from '@/entities/IReleaseNoteStreamState';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';

export interface ReleaseNotePublicationRun {
  readonly id: string;
  readonly number: number;
  readonly sha: string;
}

export interface ReleaseNotePublicationStream {
  readonly key: string;
  readonly repository: string;
  readonly workflowId: string;
  readonly branch: string;
  readonly environment: string;
}

interface PrepareReleaseNotePublicationInput {
  readonly publicationId: string;
  readonly stream: ReleaseNotePublicationStream;
  readonly currentRun: ReleaseNotePublicationRun;
  readonly bootstrapPreviousRun: ReleaseNotePublicationRun | null;
}

export interface BlockedReleaseNotePublication {
  readonly blockedByRunNumber: number;
}

export interface PublishedFrontendReleaseRange extends ReleaseNoteDropReference {
  readonly wave_id: string;
  readonly previous_sha: string;
  readonly current_sha: string;
}

function queryOptions(ctx: RequestContext) {
  return ctx.connection ? { wrappedConnection: ctx.connection } : undefined;
}

export class ReleaseNotePublicationDb extends LazyDbAccessCompatibleService {
  public constructor(sqlExecutorSupplier: () => SqlExecutor = dbSupplier) {
    super(sqlExecutorSupplier);
  }

  public async findPublishedFrontendReleaseRanges(
    {
      repository,
      waveIds,
      authorId
    }: {
      repository: string;
      waveIds: readonly string[];
      authorId: string;
    },
    ctx: RequestContext
  ): Promise<PublishedFrontendReleaseRange[]> {
    const ranges = await this.db.execute<
      PublishedFrontendReleaseRange & { readonly published_at: number }
    >(
      `select d.id, d.wave_id, d.serial_no, d.created_at as published_at,
              nullif(substring_index(part.content, char(10), 1), '') as content,
              cast(p.current_run_number as char) as run_number,
              p.previous_sha, p.current_sha,
              (select m.data_value from ${DROP_METADATA_TABLE} m
               where m.drop_id = d.id and m.data_key = 'release_note_deployed_at'
               order by m.id asc limit 1) as deployed_at
       from ${RELEASE_NOTE_STREAM_STATES_TABLE} s
       join ${RELEASE_NOTE_PUBLICATIONS_TABLE} p on p.stream_key = s.stream_key
       join ${DROPS_TABLE} d on d.id = p.last_drop_id
       join ${DROPS_PARTS_TABLE} part on part.drop_id = d.id and part.drop_part_id = 1
       where s.repository = :repository and s.branch = 'main' and s.environment = 'prod'
         and p.status = :completed and d.author_id = :authorId and d.wave_id in (:waveIds)
         and exists (select 1 from ${DROP_METADATA_TABLE} m
                     where m.drop_id = d.id and m.data_key = 'release_note_repository'
                       and m.data_value = s.repository)
         and exists (select 1 from ${DROP_METADATA_TABLE} m
                     where m.drop_id = d.id and m.data_key = 'release_note_sha'
                       and m.data_value = p.current_sha)`,
      {
        repository,
        waveIds,
        authorId,
        completed: ReleaseNotePublicationStatus.Completed
      },
      queryOptions(ctx)
    );
    const deploymentTime = (range: (typeof ranges)[number]) => {
      const timestamp = Date.parse(range.deployed_at ?? '');
      return Number.isNaN(timestamp) ? range.published_at : timestamp;
    };
    return ranges.sort(
      (a, b) =>
        deploymentTime(a) - deploymentTime(b) || a.serial_no - b.serial_no
    );
  }

  public async findStreamState(
    streamKey: string,
    ctx: RequestContext
  ): Promise<ReleaseNoteStreamStateEntity | null> {
    const timerName = `${this.constructor.name}->findStreamState`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.oneOrNull<ReleaseNoteStreamStateEntity>(
        `select * from ${RELEASE_NOTE_STREAM_STATES_TABLE}
         where stream_key = :streamKey`,
        { streamKey },
        queryOptions(ctx)
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async preparePublication(
    input: PrepareReleaseNotePublicationInput,
    ctx: RequestContext
  ): Promise<
    ReleaseNotePublicationEntity | BlockedReleaseNotePublication | null
  > {
    const timerName = `${this.constructor.name}->preparePublication`;
    ctx.timer?.start(timerName);
    try {
      return await this.executeNativeQueriesInTransaction(
        async (connection) => {
          const txCtx = { ...ctx, connection };
          const existing = await this.findPublicationForUpdate(
            input.publicationId,
            txCtx
          );
          if (existing) {
            return existing;
          }

          let streamState = await this.findStreamForUpdate(
            input.stream.key,
            txCtx
          );
          if (!streamState) {
            if (!input.bootstrapPreviousRun) {
              return null;
            }
            await this.insertStreamState(
              input.stream,
              input.bootstrapPreviousRun,
              txCtx
            );
            streamState = await this.findStreamForUpdate(
              input.stream.key,
              txCtx
            );
            if (!streamState) {
              throw new Error(
                `Failed to initialize release-note stream ${input.stream.key}`
              );
            }
          }

          const superseded =
            streamState.last_completed_run_number >= input.currentRun.number;
          if (!superseded) {
            const blocking = await this.findBlockingPublication(
              input.stream.key,
              input.currentRun.number,
              txCtx
            );
            if (blocking) {
              // Waiting is a normal application outcome, not a failed DB transaction.
              return { blockedByRunNumber: blocking.current_run_number };
            }
          }

          await this.insertPublication(
            input,
            streamState,
            superseded
              ? ReleaseNotePublicationStatus.Superseded
              : ReleaseNotePublicationStatus.Pending,
            txCtx
          );
          return await this.findPublicationForUpdate(
            input.publicationId,
            txCtx
          );
        }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async recordPlan(
    publicationId: string,
    totalParts: number,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->recordPlan`;
    ctx.timer?.start(timerName);
    try {
      await this.executeNativeQueriesInTransaction(async (connection) => {
        const txCtx = { ...ctx, connection };
        const publication = await this.requireActivePublicationForUpdate(
          publicationId,
          txCtx
        );
        if (
          publication.total_parts !== null &&
          publication.total_parts !== totalParts
        ) {
          throw new Error(
            `Release-note publication ${publicationId} changed its total part count`
          );
        }
        await this.db.execute(
          `update ${RELEASE_NOTE_PUBLICATIONS_TABLE}
           set total_parts = :totalParts,
               status = :publishing,
               updated_at = :updatedAt
           where publication_id = :publicationId`,
          {
            publicationId,
            totalParts,
            publishing: ReleaseNotePublicationStatus.Publishing,
            updatedAt: Date.now()
          },
          queryOptions(txCtx)
        );
      });
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async recordPart(
    {
      publicationId,
      partNumber,
      totalParts,
      dropId
    }: {
      readonly publicationId: string;
      readonly partNumber: number;
      readonly totalParts: number;
      readonly dropId: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->recordPart`;
    ctx.timer?.start(timerName);
    try {
      await this.executeNativeQueriesInTransaction(async (connection) => {
        const txCtx = { ...ctx, connection };
        const publication = await this.requireActivePublicationForUpdate(
          publicationId,
          txCtx
        );
        if (
          publication.total_parts !== null &&
          publication.total_parts !== totalParts
        ) {
          throw new Error(
            `Release-note publication ${publicationId} changed its total part count`
          );
        }
        if (publication.next_part > partNumber) {
          return;
        }
        if (publication.next_part < partNumber) {
          throw new Error(
            `Release-note publication ${publicationId} cannot record out-of-order part ${partNumber}`
          );
        }
        await this.db.execute(
          `update ${RELEASE_NOTE_PUBLICATIONS_TABLE}
           set total_parts = :totalParts,
               next_part = :nextPart,
               last_drop_id = :dropId,
               status = :publishing,
               updated_at = :updatedAt
           where publication_id = :publicationId`,
          {
            publicationId,
            totalParts,
            nextPart: partNumber + 1,
            dropId,
            publishing: ReleaseNotePublicationStatus.Publishing,
            updatedAt: Date.now()
          },
          queryOptions(txCtx)
        );
      });
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async completePublication(
    publicationId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->completePublication`;
    ctx.timer?.start(timerName);
    try {
      await this.executeNativeQueriesInTransaction(async (connection) => {
        const txCtx = { ...ctx, connection };
        const publication = await this.findPublicationForUpdate(
          publicationId,
          txCtx
        );
        if (!publication) {
          throw new Error(
            `Release-note publication ${publicationId} does not exist`
          );
        }
        if (
          publication.status === ReleaseNotePublicationStatus.Completed ||
          publication.status === ReleaseNotePublicationStatus.Superseded
        ) {
          return;
        }
        const stream = await this.findStreamForUpdate(
          publication.stream_key,
          txCtx
        );
        if (!stream) {
          throw new Error(
            `Release-note stream ${publication.stream_key} does not exist`
          );
        }
        if (stream.last_completed_run_number > publication.current_run_number) {
          await this.updatePublicationStatus(
            publication,
            ReleaseNotePublicationStatus.Superseded,
            txCtx
          );
          return;
        }
        if (
          stream.last_completed_run_number !==
            publication.previous_run_number ||
          stream.last_completed_sha !== publication.previous_sha
        ) {
          await this.updatePublicationStatus(
            publication,
            ReleaseNotePublicationStatus.Superseded,
            txCtx
          );
          return;
        }
        if (publication.total_parts === null) {
          throw new Error(
            `Release-note publication ${publicationId} has no durable plan`
          );
        }
        if (publication.next_part <= publication.total_parts) {
          throw new Error(
            `Release-note publication ${publicationId} has unfinished parts`
          );
        }

        const now = Date.now();
        await this.db.execute(
          `update ${RELEASE_NOTE_STREAM_STATES_TABLE}
           set last_completed_run_id = :runId,
               last_completed_run_number = :runNumber,
               last_completed_sha = :sha,
               version = version + 1,
               updated_at = :updatedAt
           where stream_key = :streamKey`,
          {
            streamKey: publication.stream_key,
            runId: publication.current_run_id,
            runNumber: publication.current_run_number,
            sha: publication.current_sha,
            updatedAt: now
          },
          queryOptions(txCtx)
        );
        await this.db.execute(
          `update ${RELEASE_NOTE_PUBLICATIONS_TABLE}
           set status = :completed,
               next_part = case
                 when total_parts is null then next_part
                 else total_parts + 1
               end,
               completed_at = :completedAt,
               updated_at = :completedAt
           where publication_id = :publicationId`,
          {
            publicationId,
            completed: ReleaseNotePublicationStatus.Completed,
            completedAt: now
          },
          queryOptions(txCtx)
        );
      });
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async findPublicationForUpdate(
    publicationId: string,
    ctx: RequestContext
  ): Promise<ReleaseNotePublicationEntity | null> {
    return await this.db.oneOrNull<ReleaseNotePublicationEntity>(
      `select * from ${RELEASE_NOTE_PUBLICATIONS_TABLE}
       where publication_id = :publicationId
       for update`,
      { publicationId },
      queryOptions(ctx)
    );
  }

  private async requireActivePublicationForUpdate(
    publicationId: string,
    ctx: RequestContext
  ): Promise<ReleaseNotePublicationEntity> {
    const publication = await this.findPublicationForUpdate(publicationId, ctx);
    if (!publication) {
      throw new Error(
        `Release-note publication ${publicationId} does not exist`
      );
    }
    if (
      publication.status !== ReleaseNotePublicationStatus.Pending &&
      publication.status !== ReleaseNotePublicationStatus.Publishing
    ) {
      throw new Error(
        `Release-note publication ${publicationId} is already ${publication.status.toLowerCase()}`
      );
    }
    return publication;
  }

  private async findStreamForUpdate(
    streamKey: string,
    ctx: RequestContext
  ): Promise<ReleaseNoteStreamStateEntity | null> {
    return await this.db.oneOrNull<ReleaseNoteStreamStateEntity>(
      `select * from ${RELEASE_NOTE_STREAM_STATES_TABLE}
       where stream_key = :streamKey
       for update`,
      { streamKey },
      queryOptions(ctx)
    );
  }

  private async findBlockingPublication(
    streamKey: string,
    currentRunNumber: number,
    ctx: RequestContext
  ): Promise<ReleaseNotePublicationEntity | null> {
    return await this.db.oneOrNull<ReleaseNotePublicationEntity>(
      `select * from ${RELEASE_NOTE_PUBLICATIONS_TABLE}
       where stream_key = :streamKey
         and current_run_number < :currentRunNumber
         and status in (:pending, :publishing)
       order by current_run_number asc
       limit 1
       for update`,
      {
        streamKey,
        currentRunNumber,
        pending: ReleaseNotePublicationStatus.Pending,
        publishing: ReleaseNotePublicationStatus.Publishing
      },
      queryOptions(ctx)
    );
  }

  private async insertStreamState(
    stream: ReleaseNotePublicationStream,
    previousRun: ReleaseNotePublicationRun,
    ctx: RequestContext
  ): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `insert into ${RELEASE_NOTE_STREAM_STATES_TABLE}
       (stream_key, repository, workflow_id, branch, environment,
        last_completed_run_id, last_completed_run_number, last_completed_sha,
        version, created_at, updated_at)
       values
       (:streamKey, :repository, :workflowId, :branch, :environment,
        :runId, :runNumber, :sha, 0, :now, :now)`,
      {
        streamKey: stream.key,
        repository: stream.repository,
        workflowId: stream.workflowId,
        branch: stream.branch,
        environment: stream.environment,
        runId: previousRun.id,
        runNumber: previousRun.number,
        sha: previousRun.sha,
        now
      },
      queryOptions(ctx)
    );
  }

  private async insertPublication(
    input: PrepareReleaseNotePublicationInput,
    streamState: ReleaseNoteStreamStateEntity,
    status: ReleaseNotePublicationStatus,
    ctx: RequestContext
  ): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `insert into ${RELEASE_NOTE_PUBLICATIONS_TABLE}
       (publication_id, stream_key, current_run_id, current_run_number,
        current_sha, previous_run_id, previous_run_number, previous_sha,
        status, total_parts, next_part, last_drop_id, created_at, updated_at,
        completed_at)
       values
       (:publicationId, :streamKey, :currentRunId, :currentRunNumber,
        :currentSha, :previousRunId, :previousRunNumber, :previousSha,
        :status, null, 1, null, :now, :now, :completedAt)`,
      {
        publicationId: input.publicationId,
        streamKey: input.stream.key,
        currentRunId: input.currentRun.id,
        currentRunNumber: input.currentRun.number,
        currentSha: input.currentRun.sha,
        previousRunId: streamState.last_completed_run_id,
        previousRunNumber: streamState.last_completed_run_number,
        previousSha: streamState.last_completed_sha,
        status,
        now,
        completedAt:
          status === ReleaseNotePublicationStatus.Superseded ? now : null
      },
      queryOptions(ctx)
    );
  }

  private async updatePublicationStatus(
    publication: ReleaseNotePublicationEntity,
    status: ReleaseNotePublicationStatus,
    ctx: RequestContext
  ): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `update ${RELEASE_NOTE_PUBLICATIONS_TABLE}
       set status = :status,
           completed_at = :completedAt,
           updated_at = :completedAt
       where publication_id = :publicationId`,
      {
        publicationId: publication.publication_id,
        status,
        completedAt: now
      },
      queryOptions(ctx)
    );
  }
}

export const releaseNotePublicationDb = new ReleaseNotePublicationDb();
