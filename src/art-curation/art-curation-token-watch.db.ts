import {
  ART_CURATION_TOKEN_WATCH_DROPS_TABLE,
  ART_CURATION_TOKEN_WATCHES_TABLE,
  DROP_NFT_LINKS_TABLE,
  DROPS_TABLE
} from '@/constants';
import {
  ArtCurationTokenWatchEntity,
  ArtCurationTokenWatchStatus
} from '@/entities/IArtCurationTokenWatch';
import { ArtCurationTokenWatchDropEntity } from '@/entities/IArtCurationTokenWatchDrop';
import { DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';

export function buildArtCurationActiveDedupeKey({
  waveId,
  chain,
  contract,
  tokenId
}: {
  waveId: string;
  chain: string;
  contract: string;
  tokenId: string;
}): string {
  return `${waveId}:${chain}:${contract.toLowerCase()}:${tokenId}`;
}

export interface ArtCurationHistoricalBackfillCandidateDrop {
  readonly drop_id: string;
  readonly created_at: number;
  readonly canonical_id: string;
  readonly url_in_text: string;
}

export class ArtCurationTokenWatchDb extends LazyDbAccessCompatibleService {
  public async insertWatch(
    watch: ArtCurationTokenWatchEntity,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->insertWatch`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
        insert into ${ART_CURATION_TOKEN_WATCHES_TABLE} (
          id,
          wave_id,
          canonical_id,
          chain,
          contract,
          token_id,
          active_dedupe_key,
          owner_at_submission,
          status,
          start_block,
          start_time,
          last_checked_block,
          locked_at,
          resolved_at,
          trigger_tx_hash,
          trigger_block_number,
          trigger_log_index,
          trigger_time,
          created_at,
          updated_at
        ) values (
          :id,
          :wave_id,
          :canonical_id,
          :chain,
          :contract,
          :token_id,
          :active_dedupe_key,
          :owner_at_submission,
          :status,
          :start_block,
          :start_time,
          :last_checked_block,
          :locked_at,
          :resolved_at,
          :trigger_tx_hash,
          :trigger_block_number,
          :trigger_log_index,
          :trigger_time,
          :created_at,
          :updated_at
        )
      `,
        watch,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async upsertActiveWatchAndGet(
    watch: Omit<ArtCurationTokenWatchEntity, 'status' | 'resolved_at'> & {
      status?: ArtCurationTokenWatchStatus;
      resolved_at?: number | null;
    },
    ctx: RequestContext
  ): Promise<ArtCurationTokenWatchEntity> {
    const timerName = `${this.constructor.name}->upsertActiveWatchAndGet`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
        insert into ${ART_CURATION_TOKEN_WATCHES_TABLE} (
          id,
          wave_id,
          canonical_id,
          chain,
          contract,
          token_id,
          active_dedupe_key,
          owner_at_submission,
          status,
          start_block,
          start_time,
          last_checked_block,
          locked_at,
          resolved_at,
          trigger_tx_hash,
          trigger_block_number,
          trigger_log_index,
          trigger_time,
          created_at,
          updated_at
        ) values (
          :id,
          :wave_id,
          :canonical_id,
          :chain,
          :contract,
          :token_id,
          :active_dedupe_key,
          :owner_at_submission,
          :status,
          :start_block,
          :start_time,
          :last_checked_block,
          :locked_at,
          :resolved_at,
          :trigger_tx_hash,
          :trigger_block_number,
          :trigger_log_index,
          :trigger_time,
          :created_at,
          :updated_at
        )
        on duplicate key update updated_at = updated_at
      `,
        {
          ...watch,
          status: watch.status ?? ArtCurationTokenWatchStatus.ACTIVE,
          resolved_at: watch.resolved_at ?? null
        },
        { wrappedConnection: ctx.connection }
      );
      return (await this.db.oneOrNull<ArtCurationTokenWatchEntity>(
        `
          select * from ${ART_CURATION_TOKEN_WATCHES_TABLE}
          where active_dedupe_key = :active_dedupe_key
          limit 1
        `,
        { active_dedupe_key: watch.active_dedupe_key },
        { wrappedConnection: ctx.connection }
      ))!;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findHistoricalBackfillCandidateCanonicalIds(
    {
      waveId,
      limit
    }: {
      waveId: string;
      limit: number;
    },
    ctx: RequestContext
  ): Promise<string[]> {
    const timerName = `${this.constructor.name}->findHistoricalBackfillCandidateCanonicalIds`;
    ctx.timer?.start(timerName);
    try {
      return await this.db
        .execute<{ canonical_id: string }>(
          `
          select candidate.canonical_id
          from (
            select d.id, d.created_at, l.canonical_id
            from ${DROPS_TABLE} d
            join (
              select min(id) as link_id, drop_id
              from ${DROP_NFT_LINKS_TABLE}
              group by drop_id
              having count(*) = 1
            ) single_link on single_link.drop_id = d.id
            join ${DROP_NFT_LINKS_TABLE} l on l.id = single_link.link_id
            left join ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE} wd on wd.drop_id = d.id
            where d.wave_id = :waveId
              and d.drop_type = :dropType
              and wd.drop_id is null
              and l.canonical_id like :tokenPattern
          ) candidate
          group by candidate.canonical_id
          order by min(candidate.created_at) asc
          limit :limit
        `,
          {
            waveId,
            dropType: DropType.PARTICIPATORY,
            tokenPattern: '%:eth:0x%:%',
            limit
          },
          { wrappedConnection: ctx.connection }
        )
        .then((rows) => rows.map((row) => row.canonical_id));
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findHistoricalBackfillCandidateDrops(
    {
      waveId,
      canonicalIds
    }: {
      waveId: string;
      canonicalIds: string[];
    },
    ctx: RequestContext
  ): Promise<ArtCurationHistoricalBackfillCandidateDrop[]> {
    const timerName = `${this.constructor.name}->findHistoricalBackfillCandidateDrops`;
    ctx.timer?.start(timerName);
    try {
      if (!canonicalIds.length) {
        return [];
      }
      return await this.db.execute<ArtCurationHistoricalBackfillCandidateDrop>(
        `
        select
          d.id as drop_id,
          d.created_at,
          l.canonical_id,
          l.url_in_text
        from ${DROPS_TABLE} d
        join (
          select min(id) as link_id, drop_id
          from ${DROP_NFT_LINKS_TABLE}
          group by drop_id
          having count(*) = 1
        ) single_link on single_link.drop_id = d.id
        join ${DROP_NFT_LINKS_TABLE} l on l.id = single_link.link_id
        left join ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE} wd on wd.drop_id = d.id
        where d.wave_id = :waveId
          and d.drop_type = :dropType
          and wd.drop_id is null
          and l.canonical_id in (:canonicalIds)
        order by l.canonical_id asc, d.created_at asc, d.id asc
      `,
        {
          waveId,
          dropType: DropType.PARTICIPATORY,
          canonicalIds
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async upsertDropWatch(
    entity: ArtCurationTokenWatchDropEntity,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->upsertDropWatch`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
        insert into ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE} (
          watch_id,
          drop_id,
          canonical_id,
          url_in_text,
          owner_at_submission,
          created_at,
          updated_at
        ) values (
          :watch_id,
          :drop_id,
          :canonical_id,
          :url_in_text,
          :owner_at_submission,
          :created_at,
          :updated_at
        )
        on duplicate key update
          watch_id = values(watch_id),
          canonical_id = values(canonical_id),
          url_in_text = values(url_in_text),
          owner_at_submission = values(owner_at_submission),
          updated_at = values(updated_at)
      `,
        entity,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async detachDropFromWatch(
    dropId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->detachDropFromWatch`;
    ctx.timer?.start(timerName);
    try {
      const association = await this.db.oneOrNull<{ watch_id: string }>(
        `
        select watch_id
        from ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE}
        where drop_id = :dropId
        limit 1
      `,
        { dropId },
        { wrappedConnection: ctx.connection }
      );
      if (!association) {
        return;
      }
      await this.db.execute(
        `
        delete from ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE}
        where drop_id = :dropId
      `,
        { dropId },
        { wrappedConnection: ctx.connection }
      );
      await this.cancelIfEmpty(association.watch_id, ctx);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async cancelIfEmpty(
    watchId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->cancelIfEmpty`;
    ctx.timer?.start(timerName);
    try {
      const remaining = await this.db
        .oneOrNull<{ cnt: number }>(
          `
          select count(*) as cnt
          from ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE}
          where watch_id = :watchId
        `,
          { watchId },
          { wrappedConnection: ctx.connection }
        )
        .then((it) => it?.cnt ?? 0);
      if (remaining === 0) {
        await this.cancel(watchId, ctx);
      }
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async lockNextActiveWatch(
    {
      lockTtlMs,
      excludedWatchIds = []
    }: {
      lockTtlMs: number;
      excludedWatchIds?: string[];
    },
    ctx: RequestContext
  ): Promise<ArtCurationTokenWatchEntity | null> {
    const timerName = `${this.constructor.name}->lockNextActiveWatch`;
    ctx.timer?.start(timerName);
    try {
      const exclusionClause = excludedWatchIds.length
        ? `and id not in (:excludedWatchIds)`
        : '';
      return await this.db.executeNativeQueriesInTransaction(
        async (connection) => {
          const entity = await this.db.oneOrNull<ArtCurationTokenWatchEntity>(
            `
            select *
            from ${ART_CURATION_TOKEN_WATCHES_TABLE}
            where status = :status
              and ifnull(locked_at, 0) < :staleBefore
              ${exclusionClause}
            order by last_checked_block asc, created_at asc
            limit 1
            for update skip locked
          `,
            {
              status: ArtCurationTokenWatchStatus.ACTIVE,
              staleBefore: Time.currentMillis() - lockTtlMs,
              excludedWatchIds
            },
            { wrappedConnection: connection }
          );
          if (!entity) {
            return null;
          }
          await this.db.execute(
            `
            update ${ART_CURATION_TOKEN_WATCHES_TABLE}
            set locked_at = :now, updated_at = :now
            where id = :id
          `,
            { id: entity.id, now: Time.currentMillis() },
            { wrappedConnection: connection }
          );
          return {
            ...entity,
            locked_at: Time.currentMillis(),
            updated_at: Time.currentMillis()
          };
        }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findByIdForUpdate(
    id: string,
    ctx: RequestContext
  ): Promise<ArtCurationTokenWatchEntity | null> {
    const timerName = `${this.constructor.name}->findByIdForUpdate`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.oneOrNull<ArtCurationTokenWatchEntity>(
        `
        select *
        from ${ART_CURATION_TOKEN_WATCHES_TABLE}
        where id = :id
        limit 1
        for update
      `,
        { id },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findActiveByDedupeKey(
    activeDedupeKey: string,
    ctx: RequestContext
  ): Promise<ArtCurationTokenWatchEntity | null> {
    const timerName = `${this.constructor.name}->findActiveByDedupeKey`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.oneOrNull<ArtCurationTokenWatchEntity>(
        `
        select *
        from ${ART_CURATION_TOKEN_WATCHES_TABLE}
        where active_dedupe_key = :activeDedupeKey
          and status = :status
        limit 1
        for update
      `,
        {
          activeDedupeKey,
          status: ArtCurationTokenWatchStatus.ACTIVE
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async unlock(watchId: string, ctx: RequestContext): Promise<void> {
    const timerName = `${this.constructor.name}->unlock`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
        update ${ART_CURATION_TOKEN_WATCHES_TABLE}
        set locked_at = null, updated_at = :now
        where id = :watchId
      `,
        { watchId, now: Time.currentMillis() },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async markChecked(
    {
      watchId,
      lastCheckedBlock
    }: {
      watchId: string;
      lastCheckedBlock: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->markChecked`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
        update ${ART_CURATION_TOKEN_WATCHES_TABLE}
        set
          last_checked_block = :lastCheckedBlock,
          locked_at = null,
          updated_at = :now
        where id = :watchId and status = :status
      `,
        {
          watchId,
          lastCheckedBlock,
          status: ArtCurationTokenWatchStatus.ACTIVE,
          now: Time.currentMillis()
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async updateHistoricalBaseline(
    {
      watchId,
      startBlock,
      startTime,
      ownerAtSubmission,
      lastCheckedBlock
    }: {
      watchId: string;
      startBlock: number;
      startTime: number;
      ownerAtSubmission: string;
      lastCheckedBlock: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->updateHistoricalBaseline`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
        update ${ART_CURATION_TOKEN_WATCHES_TABLE}
        set
          start_block = :startBlock,
          start_time = :startTime,
          owner_at_submission = :ownerAtSubmission,
          last_checked_block = :lastCheckedBlock,
          updated_at = :now
        where id = :watchId
          and status = :status
      `,
        {
          watchId,
          startBlock,
          startTime,
          ownerAtSubmission,
          lastCheckedBlock,
          status: ArtCurationTokenWatchStatus.ACTIVE,
          now: Time.currentMillis()
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async markResolved(
    {
      watchId,
      resolvedAt,
      triggerTxHash,
      triggerBlockNumber,
      triggerLogIndex,
      triggerTime
    }: {
      watchId: string;
      resolvedAt: number;
      triggerTxHash: string;
      triggerBlockNumber: number;
      triggerLogIndex: number;
      triggerTime: number;
    },
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->markResolved`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
        update ${ART_CURATION_TOKEN_WATCHES_TABLE}
        set
          status = :status,
          active_dedupe_key = null,
          locked_at = null,
          resolved_at = :resolvedAt,
          trigger_tx_hash = :triggerTxHash,
          trigger_block_number = :triggerBlockNumber,
          trigger_log_index = :triggerLogIndex,
          trigger_time = :triggerTime,
          updated_at = :resolvedAt
        where id = :watchId and status = :activeStatus
      `,
        {
          watchId,
          resolvedAt,
          triggerTxHash,
          triggerBlockNumber,
          triggerLogIndex,
          triggerTime,
          status: ArtCurationTokenWatchStatus.RESOLVED,
          activeStatus: ArtCurationTokenWatchStatus.ACTIVE
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async cancel(watchId: string, ctx: RequestContext): Promise<void> {
    const timerName = `${this.constructor.name}->cancel`;
    ctx.timer?.start(timerName);
    try {
      await this.db.execute(
        `
        update ${ART_CURATION_TOKEN_WATCHES_TABLE}
        set
          status = :status,
          active_dedupe_key = null,
          locked_at = null,
          updated_at = :now
        where id = :watchId and status = :activeStatus
      `,
        {
          watchId,
          now: Time.currentMillis(),
          status: ArtCurationTokenWatchStatus.CANCELLED,
          activeStatus: ArtCurationTokenWatchStatus.ACTIVE
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findTrackedParticipatoryDropIds(
    watchId: string,
    ctx: RequestContext
  ): Promise<string[]> {
    const timerName = `${this.constructor.name}->findTrackedParticipatoryDropIds`;
    ctx.timer?.start(timerName);
    try {
      return await this.db
        .execute<{ drop_id: string }>(
          `
          select wd.drop_id
          from ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE} wd
          join ${DROPS_TABLE} d on d.id = wd.drop_id
          where wd.watch_id = :watchId
            and d.drop_type = :dropType
        `,
          {
            watchId,
            dropType: DropType.PARTICIPATORY
          },
          { wrappedConnection: ctx.connection }
        )
        .then((rows) => rows.map((row) => row.drop_id));
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async findByDropId(
    dropId: string,
    ctx: RequestContext
  ): Promise<ArtCurationTokenWatchDropEntity | null> {
    const timerName = `${this.constructor.name}->findByDropId`;
    ctx.timer?.start(timerName);
    try {
      return await this.db.oneOrNull<ArtCurationTokenWatchDropEntity>(
        `
        select *
        from ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE}
        where drop_id = :dropId
        limit 1
      `,
        { dropId },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const artCurationTokenWatchDb = new ArtCurationTokenWatchDb(dbSupplier);
