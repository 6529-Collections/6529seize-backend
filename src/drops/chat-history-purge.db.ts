import {
  ACTIVITY_EVENTS_TABLE,
  ART_CURATION_TOKEN_WATCH_DROPS_TABLE,
  ART_CURATION_TOKEN_WATCHES_TABLE,
  DELETED_DROPS_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_BOOKMARKS_TABLE,
  DROP_BOOSTS_TABLE,
  DROP_CURATIONS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_MENTIONED_GROUPS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_METADATA_TABLE,
  DROP_NFT_LINKS_TABLE,
  DROP_POLLS_TABLE,
  DROP_POLL_OPTIONS_TABLE,
  DROP_POLL_VOTES_TABLE,
  DROP_RANK_TABLE,
  DROP_REACTIONS_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_MENTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVE_CURATIONS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVE_METRICS_TABLE,
  WAVE_DROPPER_METRICS_TABLE
} from '@/constants';
import { DropEntity } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';

export const CHAT_HISTORY_PURGE_BATCH_SIZE = 100;
export type ChatHistoryPurgeScope = {
  waveId: string;
  authorId: string;
  cutoffSerialNo: number;
};

// Keep this inventory aligned with DeleteDropUseCase. Shared assets (uploads,
// attachments, NFT metadata) and reply/quote references survive; drop-owned
// associations do not. Special ordering/watch semantics are handled below.
const DROP_OWNED_TABLES = [
  DROPS_PARTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_MENTIONED_GROUPS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROP_METADATA_TABLE,
  DROP_REACTIONS_TABLE,
  DROP_POLL_VOTES_TABLE,
  DROP_POLL_OPTIONS_TABLE,
  DROP_POLLS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  DROP_BOOKMARKS_TABLE,
  DROP_BOOSTS_TABLE,
  DROP_NFT_LINKS_TABLE
] as const;

export class ChatHistoryPurgeDb extends LazyDbAccessCompatibleService {
  async findCutoff(
    scope: Pick<ChatHistoryPurgeScope, 'waveId' | 'authorId'>,
    ctx: RequestContext
  ): Promise<number> {
    const timerName = `${this.constructor.name}->findCutoff`;
    ctx.timer?.start(timerName);
    try {
      const row = await this.db.oneOrNull<{ serial_no: number }>(
        `select serial_no from ${DROPS_TABLE} force index (idx_drop_wave_type_author)
         where wave_id = :waveId and author_id = :authorId and drop_type = 'CHAT'
         order by serial_no desc limit 1`,
        scope,
        { wrappedConnection: ctx.connection }
      );
      return Number(row?.serial_no ?? 0);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async findBatchForUpdate(
    scope: ChatHistoryPurgeScope & { pinnedDropId: string | null },
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    if (!ctx.connection)
      throw new Error('Chat history purge requires a transaction');
    const timerName = `${this.constructor.name}->findBatchForUpdate`;
    ctx.timer?.start(timerName);
    try {
      // InnoDB's secondary index includes the serial_no primary key, allowing
      // a bounded ordered range without sorting/locking the entire history.
      return await this.db.execute<DropEntity>(
        `select * from ${DROPS_TABLE} force index (idx_drop_wave_type_author)
         where wave_id = :waveId and drop_type = 'CHAT' and author_id = :authorId
           and serial_no <= :cutoffSerialNo
           and (:pinnedDropId is null or id <> :pinnedDropId)
         order by serial_no asc limit :limit for update`,
        { ...scope, limit: CHAT_HISTORY_PURGE_BATCH_SIZE + 1 },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async deleteBatch(
    scope: ChatHistoryPurgeScope,
    dropIds: string[],
    ctx: RequestContext
  ): Promise<void> {
    if (!dropIds.length) return;
    if (!ctx.connection || dropIds.length > CHAT_HISTORY_PURGE_BATCH_SIZE) {
      throw new Error('Chat history purge requires a bounded transaction');
    }
    const timerName = `${this.constructor.name}->deleteBatch`;
    ctx.timer?.start(timerName);
    try {
      await this.deleteCurations(dropIds, ctx);
      await this.detachTokenWatches(dropIds, ctx);
      const params = {
        ...scope,
        dropIds,
        now: Time.currentMillis(),
        count: dropIds.length
      };
      const options = { wrappedConnection: ctx.connection };
      // Insert from the locked rows so tombstones retain original creation data.
      await this.db.execute(
        `insert into ${DELETED_DROPS_TABLE} (id, wave_id, author_id, created_at, deleted_at)
         select id, wave_id, author_id, created_at, :now from ${DROPS_TABLE} where id in (:dropIds)`,
        params,
        options
      );
      for (const table of DROP_OWNED_TABLES) {
        await this.db.execute(
          `delete from ${table} where drop_id in (:dropIds)`,
          params,
          options
        );
      }
      for (const column of ['related_drop_id', 'related_drop_2_id']) {
        await this.db.execute(
          `delete from ${IDENTITY_NOTIFICATIONS_TABLE} where ${column} in (:dropIds)`,
          params,
          options
        );
      }
      await this.db.execute(
        `delete from ${ACTIVITY_EVENTS_TABLE} where drop_id in (:dropIds)`,
        params,
        options
      );
      await this.db.execute(
        `delete from ${ACTIVITY_EVENTS_TABLE} where target_type = 'DROP' and target_id in (:dropIds)`,
        params,
        options
      );
      await this.db.execute(
        `delete from ${IDENTITY_SUBSCRIPTIONS_TABLE} where target_type = 'DROP' and target_id in (:dropIds)`,
        params,
        options
      );
      await this.db.execute(
        `delete from ${DROPS_TABLE} where id in (:dropIds)`,
        params,
        options
      );
      await this.db.execute(
        `update ${WAVE_METRICS_TABLE} set drops_count = greatest(drops_count - :count, 0),
         latest_drop_timestamp = (select ifnull(max(created_at), 0) from ${DROPS_TABLE} where wave_id = :waveId)
         where wave_id = :waveId`,
        params,
        options
      );
      await this.db.execute(
        `update ${WAVE_DROPPER_METRICS_TABLE} set drops_count = greatest(drops_count - :count, 0),
         latest_drop_timestamp = (select ifnull(max(created_at), 0) from ${DROPS_TABLE} where wave_id = :waveId and author_id = :authorId)
         where wave_id = :waveId and dropper_id = :authorId`,
        params,
        options
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  private async deleteCurations(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<void> {
    const options = { wrappedConnection: ctx.connection };
    const curations = await this.db.execute<{ id: string }>(
      `select distinct curation_id as id from ${DROP_CURATIONS_TABLE}
       where drop_id in (:dropIds) order by curation_id`,
      { dropIds },
      options
    );
    if (!curations.length) return;
    const params = { dropIds, curationIds: curations.map((it) => it.id) };
    // Use the same parent lock as curation add/reorder and single-drop deletion.
    // Orphan associations must still be cleaned when a parent no longer exists.
    await this.db.execute(
      `select id from ${WAVE_CURATIONS_TABLE} where id in (:curationIds)
       order by id for update`,
      params,
      options
    );
    await this.db.execute(
      `select drop_id from ${DROP_CURATIONS_TABLE} where curation_id in (:curationIds)
       order by curation_id, (priority_order is null), priority_order, created_at, drop_id for update`,
      params,
      options
    );
    await this.db.execute(
      `delete from ${DROP_CURATIONS_TABLE} where drop_id in (:dropIds)`,
      params,
      options
    );
    // Window results are materialized by MySQL. Compact once per affected
    // curation, preserving exactly the canonical priority/creation/ID ordering.
    await this.db.execute(
      `update ${DROP_CURATIONS_TABLE} dc join (
         select drop_id, curation_id, row_number() over (
           partition by curation_id order by (priority_order is null), priority_order, created_at, drop_id
         ) as new_priority from ${DROP_CURATIONS_TABLE} where curation_id in (:curationIds)
       ) ordered on dc.drop_id = ordered.drop_id and dc.curation_id = ordered.curation_id
       set dc.priority_order = ordered.new_priority`,
      params,
      options
    );
  }

  private async detachTokenWatches(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<void> {
    const options = { wrappedConnection: ctx.connection };
    const watches = await this.db.execute<{ id: string }>(
      `select w.id from ${ART_CURATION_TOKEN_WATCHES_TABLE} w
       where w.id in (select watch_id from ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE} where drop_id in (:dropIds))
       order by w.id for update`,
      { dropIds },
      options
    );
    await this.db.execute(
      `delete from ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      options
    );
    if (!watches.length) return;
    await this.db.execute(
      `update ${ART_CURATION_TOKEN_WATCHES_TABLE} w
       set status = 'CANCELLED', active_dedupe_key = null, locked_at = null, updated_at = :now
       where id in (:watchIds) and status = 'ACTIVE' and not exists (
         select 1 from ${ART_CURATION_TOKEN_WATCH_DROPS_TABLE} wd where wd.watch_id = w.id
       )`,
      { watchIds: watches.map((it) => it.id), now: Time.currentMillis() },
      options
    );
  }
}

export const chatHistoryPurgeDb = new ChatHistoryPurgeDb(dbSupplier);
