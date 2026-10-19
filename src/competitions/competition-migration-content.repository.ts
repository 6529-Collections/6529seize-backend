import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_MENTIONED_GROUPS_TABLE
} from '@/constants';
import type { DropEntity } from '@/entities/IDrop';
import type { RequestContext } from '@/request.context';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import type { CompetitionEntryContent } from '@/competitions/competition-entry.repository';
import {
  assembleLegacyDropContent,
  LegacyDropContentRelations
} from '@/competitions/competition-entry-content-source';

const SOURCE_CONTENT_QUERIES = {
  parts: `select * from ${DROPS_PARTS_TABLE} where drop_id in (:dropIds) order by drop_id,drop_part_id`,
  media: `select * from ${DROP_MEDIA_TABLE} where drop_id in (:dropIds) order by drop_id,id`,
  attachments: `select drop_id,drop_part_id,attachment_id from ${DROP_ATTACHMENTS_TABLE} where drop_id in (:dropIds) order by drop_id,drop_part_id,attachment_id`,
  metadata: `select drop_id,data_key,data_value from ${DROP_METADATA_TABLE} where drop_id in (:dropIds) order by drop_id,id`,
  referenced_nfts: `select drop_id,contract,token,name from ${DROP_REFERENCED_NFTS_TABLE} where drop_id in (:dropIds) order by drop_id,id`,
  mentioned_users: `select drop_id,handle_in_content as handle,mentioned_profile_id as profile_id from ${DROPS_MENTIONS_TABLE} where drop_id in (:dropIds) order by drop_id,id`,
  mentioned_waves: `select drop_id,wave_id,wave_name_in_content from ${DROP_MENTIONED_WAVES_TABLE} where drop_id in (:dropIds) order by drop_id,id`,
  groups: `select drop_id,mentioned_group from ${DROP_MENTIONED_GROUPS_TABLE} where drop_id in (:dropIds) order by drop_id,mentioned_group`
} as const;

/** Read all content fields in bounded pages on the comparison snapshot. */
export class CompetitionMigrationContentRepository extends LazyDbAccessCompatibleService {
  private async sourceRows<K extends keyof LegacyDropContentRelations>(
    source: K,
    dropIds: readonly string[],
    ctx: RequestContext
  ): Promise<Map<string, LegacyDropContentRelations[K][number][]>> {
    const timerName = `${this.constructor.name}->sourceRows:${source}`;
    ctx.timer?.start(timerName);
    try {
      const rows = await this.db.execute<
        LegacyDropContentRelations[K][number] & { drop_id: string }
      >(
        SOURCE_CONTENT_QUERIES[source],
        { dropIds },
        { wrappedConnection: ctx.connection }
      );
      const result = new Map<string, LegacyDropContentRelations[K][number][]>();
      for (const row of rows) {
        const { drop_id } = row;
        const value = { ...row };
        Reflect.deleteProperty(value, 'drop_id');
        const entries = result.get(drop_id) ?? [];
        entries.push(value);
        result.set(drop_id, entries);
      }
      return result;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async sourcePage(
    drops: readonly DropEntity[],
    ctx: RequestContext
  ): Promise<Map<string, CompetitionEntryContent>> {
    const timerName = `${this.constructor.name}->sourcePage`;
    ctx.timer?.start(timerName);
    try {
      if (!drops.length) return new Map();
      if (drops.length > 100)
        throw new Error('Content comparison page exceeds 100 drops');
      const ids = drops.map((drop) => drop.id);
      // One transaction connection: execute relation reads sequentially.
      const parts = await this.sourceRows('parts', ids, ctx);
      const media = await this.sourceRows('media', ids, ctx);
      const attachments = await this.sourceRows('attachments', ids, ctx);
      const metadata = await this.sourceRows('metadata', ids, ctx);
      const referenced_nfts = await this.sourceRows(
        'referenced_nfts',
        ids,
        ctx
      );
      const mentioned_users = await this.sourceRows(
        'mentioned_users',
        ids,
        ctx
      );
      const mentioned_waves = await this.sourceRows(
        'mentioned_waves',
        ids,
        ctx
      );
      const groups = await this.sourceRows('groups', ids, ctx);
      return new Map(
        drops.map((drop) => [
          drop.id,
          assembleLegacyDropContent(drop, {
            parts: parts.get(drop.id) ?? [],
            media: media.get(drop.id) ?? [],
            attachments: attachments.get(drop.id) ?? [],
            metadata: metadata.get(drop.id) ?? [],
            referenced_nfts: referenced_nfts.get(drop.id) ?? [],
            mentioned_users: mentioned_users.get(drop.id) ?? [],
            mentioned_waves: mentioned_waves.get(drop.id) ?? [],
            groups: groups.get(drop.id) ?? []
          })
        ])
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  public async nativePage(
    competitionId: string,
    entryIds: readonly string[],
    ctx: RequestContext
  ): Promise<Map<string, CompetitionEntryContent>> {
    const timerName = `${this.constructor.name}->nativePage`;
    ctx.timer?.start(timerName);
    try {
      if (!entryIds.length) return new Map();
      if (entryIds.length > 100)
        throw new Error('Content comparison page exceeds 100 entries');
      // The physical primary key is (entry_id, version), so equal-version
      // ties are impossible. This is the same latest-version order as getContent.
      const rows = await this.db.execute<{
        entry_id: string;
        content: CompetitionEntryContent | string;
      }>(
        `select entry_id,content from (
         select v.entry_id,v.content,row_number() over(partition by v.entry_id order by v.version desc) as version_order
         from ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} v
         join ${COMPETITION_ENTRIES_TABLE} e on e.id=v.entry_id and e.competition_id=v.competition_id
         where v.competition_id=:competitionId and v.entry_id in (:entryIds) and e.status in ('ACTIVE','WINNER')
         ) versions where version_order=1`,
        { competitionId, entryIds },
        { wrappedConnection: ctx.connection }
      );
      return new Map(
        rows.map((row) => [
          row.entry_id,
          typeof row.content === 'string'
            ? (JSON.parse(row.content) as CompetitionEntryContent)
            : row.content
        ])
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}
