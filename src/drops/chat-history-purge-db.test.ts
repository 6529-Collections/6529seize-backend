import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import {
  ChatHistoryPurgeDb,
  CHAT_HISTORY_PURGE_BATCH_SIZE
} from './chat-history-purge.db';
import * as tables from '@/constants';

const wave = aWave(
  { description_drop_id: 'pin' },
  { id: 'wave', name: 'Synthetic purge test' }
);
const scope = { waveId: 'wave', authorId: 'author', cutoffSerialNo: 60000 };
const repo = new ChatHistoryPurgeDb(() => sqlExecutor);
async function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await sqlExecutor.execute(
    `insert into ${table} (${columns.join(',')}) values (${columns.map((c) => ':' + c).join(',')})`,
    row
  );
}
async function insertDrops(count: number, offset = 0) {
  for (let start = 0; start < count; start += 1000) {
    const rows = Array.from(
      { length: Math.min(1000, count - start) },
      (_, i) => {
        const serial = offset + start + i + 1;
        return [
          serial,
          `drop-${serial}`,
          'wave',
          serial % 3 === 0 ? 'other' : 'author',
          serial,
          1,
          'CHAT'
        ];
      }
    );
    await sqlExecutor.execute(
      `insert into ${tables.DROPS_TABLE} (serial_no,id,wave_id,author_id,created_at,parts_count,drop_type)
       select n, concat('drop-', n), 'wave', if(mod(n, 3) = 0, 'other', 'author'), n, 1, 'CHAT'
       from json_table(:serials, '$[*]' columns(n bigint path '$')) numbers`,
      { serials: JSON.stringify(rows.map((row) => row[0])) }
    );
  }
}
async function purge(cutoffSerialNo: number, pinnedDropId = 'pin') {
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const ctx = { connection };
    await wavesApiDb.findWaveByIdForUpdate('wave', ctx);
    const frozen = { ...scope, cutoffSerialNo };
    const candidates = await repo.findBatchForUpdate(
      { ...frozen, pinnedDropId },
      ctx
    );
    const drops = candidates.slice(0, CHAT_HISTORY_PURGE_BATCH_SIZE);
    await repo.deleteBatch(
      frozen,
      drops.map((d) => d.id),
      ctx
    );
    return {
      ids: drops.map((d) => d.id),
      hasMore: candidates.length > CHAT_HISTORY_PURGE_BATCH_SIZE
    };
  });
}

describeWithSeed(
  'ChatHistoryPurgeDb synthetic MySQL cleanup',
  withWaves([wave]),
  () => {
    it('purges 40,000 of 60,000 messages in bounded transactions, preserving newer messages and retries', async () => {
      await insertDrops(60000);
      const cutoff = await sqlExecutor.executeNativeQueriesInTransaction(
        (connection) => repo.findCutoff('wave', { connection })
      );
      expect(cutoff).toBe(60000);
      await insertDrops(3, 60000);
      await insert(tables.WAVE_METRICS_TABLE, {
        wave_id: 'wave',
        drops_count: 60003
      });
      await insert(tables.WAVE_DROPPER_METRICS_TABLE, {
        wave_id: 'wave',
        dropper_id: 'author',
        drops_count: 40002
      });
      const deleted = new Set<string>();
      let hasMore = true;
      let batches = 0;
      const startedAt = Date.now();
      let maxBatchMillis = 0;
      while (hasMore) {
        const batchStartedAt = Date.now();
        const result = await purge(cutoff);
        maxBatchMillis = Math.max(maxBatchMillis, Date.now() - batchStartedAt);
        expect(result.ids.length).toBeLessThanOrEqual(100);
        result.ids.forEach((id) => {
          expect(deleted.has(id)).toBe(false);
          deleted.add(id);
        });
        hasMore = result.hasMore;
        batches++;
      }
      process.stdout.write(
        `Synthetic purge: 40000 messages in ${batches} batches, ${Date.now() - startedAt}ms total, ${maxBatchMillis}ms slowest batch\n`
      );
      expect(batches).toBe(400);
      expect(deleted.size).toBe(40000);
      expect(await purge(cutoff)).toEqual({ ids: [], hasMore: false });
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from ${tables.DELETED_DROPS_TABLE}`
        )
      ).toEqual({ count: 40000 });
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from ${tables.DROPS_TABLE}`
        )
      ).toEqual({ count: 20003 });
      expect(
        await sqlExecutor.oneOrNull(
          `select drops_count, latest_drop_timestamp from ${tables.WAVE_METRICS_TABLE} where wave_id = 'wave'`
        )
      ).toEqual({ drops_count: 20003, latest_drop_timestamp: 60003 });
      expect(
        await sqlExecutor.oneOrNull(
          `select drops_count, latest_drop_timestamp from ${tables.WAVE_DROPPER_METRICS_TABLE} where wave_id = 'wave'`
        )
      ).toEqual({ drops_count: 2, latest_drop_timestamp: 60002 });
    }, 120000);

    it('cleans dependent rows, compacts curations, preserves shared watches, scope and tombstones', async () => {
      await insertDrops(5);
      await insert(tables.DROPS_TABLE, {
        id: 'pin',
        wave_id: 'wave',
        author_id: 'author',
        created_at: 6,
        parts_count: 1,
        drop_type: 'CHAT'
      });
      await insert(tables.DROPS_TABLE, {
        id: 'participant',
        wave_id: 'wave',
        author_id: 'author',
        created_at: 7,
        parts_count: 1,
        drop_type: 'PARTICIPATORY'
      });
      await insert(tables.DROPS_TABLE, {
        id: 'winner',
        wave_id: 'wave',
        author_id: 'author',
        created_at: 8,
        parts_count: 1,
        drop_type: 'WINNER'
      });
      await insert(tables.DROPS_TABLE, {
        id: 'other-wave',
        wave_id: 'elsewhere',
        author_id: 'author',
        created_at: 9,
        parts_count: 1,
        drop_type: 'CHAT'
      });
      const fixtures: [string, Record<string, unknown>][] = [
        [tables.DROPS_PARTS_TABLE, { drop_part_id: 1, content: 'synthetic' }],
        [
          tables.DROP_ATTACHMENTS_TABLE,
          { drop_part_id: 1, attachment_id: 'shared-attachment' }
        ],
        [
          tables.DROPS_MENTIONS_TABLE,
          { mentioned_profile_id: 'reader', handle_in_content: 'reader' }
        ],
        [
          tables.DROP_MENTIONED_WAVES_TABLE,
          { wave_id: 'wave', wave_name_in_content: 'wave' }
        ],
        [tables.DROP_MENTIONED_GROUPS_TABLE, { mentioned_group: 'everyone' }],
        [
          tables.DROP_MEDIA_TABLE,
          {
            drop_part_id: 1,
            url: 'https://example.com/test.png',
            mime_type: 'image/png'
          }
        ],
        [
          tables.DROP_REFERENCED_NFTS_TABLE,
          { contract: 'contract', token: '1', name: 'synthetic' }
        ],
        [tables.DROP_METADATA_TABLE, { data_key: 'test', data_value: 'test' }],
        [
          tables.DROP_REACTIONS_TABLE,
          { profile_id: 'reader', wave_id: 'wave', reaction: 'like' }
        ],
        [
          tables.DROP_POLLS_TABLE,
          { id: 'poll', wave_id: 'wave', closing_time: 100, multichoice: false }
        ],
        [
          tables.DROP_POLL_OPTIONS_TABLE,
          {
            poll_id: 'poll',
            wave_id: 'wave',
            option_no: 1,
            option_string: 'one'
          }
        ],
        [
          tables.DROP_POLL_VOTES_TABLE,
          {
            poll_id: 'poll',
            wave_id: 'wave',
            option_no: 1,
            voter_id: 'reader',
            vote_time: 1
          }
        ],
        [
          tables.DROP_VOTER_STATE_TABLE,
          { voter_id: 'reader', wave_id: 'wave', votes: 1 }
        ],
        [
          tables.DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
          {
            voter_id: 'reader',
            wave_id: 'wave',
            credit_spent: 1,
            created_at: 1
          }
        ],
        [
          tables.DROP_RANK_TABLE,
          { wave_id: 'wave', last_increased: 1, vote: 1 }
        ],
        [
          tables.DROP_REAL_VOTE_IN_TIME_TABLE,
          { wave_id: 'wave', timestamp: 1, vote: 1 }
        ],
        [
          tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
          { voter_id: 'reader', wave_id: 'wave', timestamp: 1, vote: 1 }
        ],
        [
          tables.WAVE_LEADERBOARD_ENTRIES_TABLE,
          { wave_id: 'wave', timestamp: 1, vote: 1 }
        ],
        [
          tables.DROP_BOOKMARKS_TABLE,
          { identity_id: 'reader', bookmarked_at: 1 }
        ],
        [
          tables.DROP_BOOSTS_TABLE,
          { booster_id: 'reader', boosted_at: 1, wave_id: 'wave' }
        ],
        [
          tables.DROP_NFT_LINKS_TABLE,
          {
            canonical_id: 'nft',
            url_in_text: 'https://example.com/nft',
            created_at: 1
          }
        ]
      ];
      for (const [table, row] of fixtures)
        await insert(table, { ...row, drop_id: 'drop-1' });
      await insert(tables.IDENTITY_NOTIFICATIONS_TABLE, {
        identity_id: 'reader',
        related_drop_id: 'drop-1',
        cause: 'DROP_REPLIED',
        additional_data: '{}',
        created_at: 1
      });
      await insert(tables.IDENTITY_NOTIFICATIONS_TABLE, {
        identity_id: 'reader',
        related_drop_2_id: 'drop-2',
        cause: 'DROP_REPLIED',
        additional_data: '{}',
        created_at: 1
      });
      await insert(tables.ACTIVITY_EVENTS_TABLE, {
        target_id: 'drop-1',
        target_type: 'DROP',
        action: 'DROP_CREATED',
        data: '{}',
        created_at: 1
      });
      await insert(tables.ACTIVITY_EVENTS_TABLE, {
        target_id: 'wave',
        target_type: 'WAVE',
        drop_id: 'drop-2',
        action: 'DROP_CREATED',
        data: '{}',
        created_at: 1
      });
      await insert(tables.IDENTITY_SUBSCRIPTIONS_TABLE, {
        subscriber_id: 'reader',
        target_id: 'drop-1',
        target_type: 'DROP',
        target_action: 'DROP_REPLIED'
      });
      await insert(tables.IDENTITY_SUBSCRIPTIONS_TABLE, {
        subscriber_id: 'reader',
        target_id: 'drop-1',
        target_type: 'WAVE',
        target_action: 'DROP_REPLIED'
      });
      await insert(tables.WAVE_CURATIONS_TABLE, {
        id: 'curation',
        name: 'Curation',
        wave_id: 'wave',
        community_group_id: 'group',
        created_at: 1,
        updated_at: 1
      });
      for (const [i, dropId] of Array.from(
        ['drop-1', 'drop-3', 'drop-2', 'pin', 'drop-5'].entries()
      )) {
        await insert(tables.DROP_CURATIONS_TABLE, {
          drop_id: dropId,
          curation_id: 'curation',
          wave_id: 'wave',
          curated_by: 'reader',
          created_at: i,
          updated_at: i,
          priority_order: i + 1
        });
      }
      for (const watchId of ['empty', 'shared']) {
        await insert(tables.ART_CURATION_TOKEN_WATCHES_TABLE, {
          id: watchId,
          wave_id: 'wave',
          canonical_id: 'nft',
          chain: 'eth',
          contract: 'contract',
          token_id: '1',
          owner_at_submission: 'owner',
          start_block: 1,
          start_time: 1,
          last_checked_block: 1,
          created_at: 1,
          updated_at: 1,
          active_dedupe_key: watchId
        });
      }
      for (const [watchId, dropId] of [
        ['empty', 'drop-1'],
        ['shared', 'drop-2'],
        ['shared', 'drop-3']
      ]) {
        await insert(tables.ART_CURATION_TOKEN_WATCH_DROPS_TABLE, {
          watch_id: watchId,
          drop_id: dropId,
          canonical_id: 'nft',
          url_in_text: 'https://example.com/nft',
          owner_at_submission: 'owner',
          created_at: 1,
          updated_at: 1
        });
      }
      expect(await purge(100)).toEqual({
        ids: ['drop-1', 'drop-2', 'drop-4', 'drop-5'],
        hasMore: false
      });
      for (const [table] of fixtures)
        expect(
          await sqlExecutor.oneOrNull(`select count(*) as count from ${table}`)
        ).toEqual({ count: 0 });
      for (const table of [
        tables.IDENTITY_NOTIFICATIONS_TABLE,
        tables.ACTIVITY_EVENTS_TABLE
      ])
        expect(
          await sqlExecutor.oneOrNull(`select count(*) as count from ${table}`)
        ).toEqual({ count: 0 });
      expect(
        await sqlExecutor.execute(
          `select target_type from ${tables.IDENTITY_SUBSCRIPTIONS_TABLE}`
        )
      ).toEqual([{ target_type: 'WAVE' }]);
      expect(
        await sqlExecutor.execute(
          `select drop_id, priority_order from ${tables.DROP_CURATIONS_TABLE} order by priority_order`
        )
      ).toEqual([
        { drop_id: 'drop-3', priority_order: 1 },
        { drop_id: 'pin', priority_order: 2 }
      ]);
      expect(
        await sqlExecutor.execute(
          `select id, status, active_dedupe_key from ${tables.ART_CURATION_TOKEN_WATCHES_TABLE} order by id`
        )
      ).toEqual([
        { id: 'empty', status: 'CANCELLED', active_dedupe_key: null },
        { id: 'shared', status: 'ACTIVE', active_dedupe_key: 'shared' }
      ]);
      expect(
        await sqlExecutor.oneOrNull(
          `select author_id, created_at from ${tables.DELETED_DROPS_TABLE} where id = 'drop-1'`
        )
      ).toEqual({ author_id: 'author', created_at: 1 });
      expect(
        await sqlExecutor.execute(
          `select id from ${tables.DROPS_TABLE} order by id`
        )
      ).toEqual(
        ['drop-3', 'other-wave', 'participant', 'pin', 'winner'].map((id) => ({
          id
        }))
      );
    });

    it('serializes concurrent batches and rolls back dependent data with the transaction', async () => {
      await insertDrops(450);
      const [first, second] = await Promise.all([purge(450), purge(450)]);
      expect(new Set([...first.ids, ...second.ids]).size).toBe(200);
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await wavesApiDb.findWaveByIdForUpdate('wave', { connection });
          const batch = await repo.findBatchForUpdate(
            { ...scope, pinnedDropId: 'pin' },
            { connection }
          );
          await repo.deleteBatch(
            scope,
            batch.slice(0, 100).map((d) => d.id),
            { connection }
          );
          throw new Error('rollback test');
        })
      ).rejects.toThrow('rollback test');
      expect(
        await sqlExecutor.oneOrNull(
          `select count(*) as count from ${tables.DELETED_DROPS_TABLE}`
        )
      ).toEqual({ count: 200 });
      expect((await purge(450)).ids).toHaveLength(100);
    });
  }
);
