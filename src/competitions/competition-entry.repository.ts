import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  CONTENT_MODERATION_ITEMS_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_METADATA_TABLE,
  DROP_REFERENCED_NFTS_TABLE,
  DROPS_MENTIONS_TABLE,
  DROP_MENTIONED_WAVES_TABLE,
  DROP_ATTACHMENTS_TABLE,
  DROP_MENTIONED_GROUPS_TABLE
} from '@/constants';
import { CompetitionEntry } from '@/competitions/competition.types';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { DropEntity, DropPartEntity, DropMediaEntity } from '@/entities/IDrop';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { competitionConflict } from '@/competitions/competition-command.repository';
import { moderationFingerprint } from '@/content-moderation/moderation-review.types';
import { withoutLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';

export type CompetitionEntryContent = Pick<
  CreateOrUpdateDropModel,
  | 'wave_id'
  | 'title'
  | 'parts'
  | 'metadata'
  | 'referenced_nfts'
  | 'mentioned_waves'
  | 'mentioned_groups'
  | 'reply_to'
  | 'hide_link_preview'
> & { readonly mentioned_users: Array<{ handle: string; profile_id: string }> };
export type NativeDropEntry = CompetitionEntry & {
  readonly signed: boolean;
  readonly legacy_origin?: boolean;
};

export class CompetitionEntryRepository extends LazyDbAccessCompatibleService {
  private async rows<T>(
    name: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    const timer = `${this.constructor.name}->${name}`;
    ctx.timer?.start(timer);
    try {
      return await this.db.execute<T>(sql, params, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  public async findDropEntries(
    dropId: string,
    ctx: RequestContext
  ): Promise<NativeDropEntry[]> {
    return this.findEntries(dropId, false, ctx);
  }

  private async findEntries(
    dropId: string,
    currentRead: boolean,
    ctx: RequestContext
  ): Promise<NativeDropEntry[]> {
    const rows = await withoutLegacyCompetitionGetFacade(() =>
      this.rows<NativeDropEntry>(
        'findDropEntries',
        `select e.*, c.legacy_wave_id is not null and exists(select 1 from ${DROPS_TABLE} d where d.id=e.drop_id and d.drop_type in ('PARTICIPATORY','WINNER')) as legacy_origin, exists(select 1 from ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} v where v.entry_id=e.id and v.signature is not null) as signed
       from ${COMPETITION_ENTRIES_TABLE} e join ${COMPETITIONS_TABLE} c on c.id=e.competition_id
       where e.drop_id=:dropId and c.storage_mode='NATIVE' order by e.competition_id,e.id${currentRead ? ' for update' : ''}`,
        { dropId },
        ctx
      )
    );
    return rows.map((row) => ({
      ...row,
      signed: Boolean(row.signed),
      legacy_origin: Boolean(row.legacy_origin),
      config_version: Number(row.config_version),
      submitted_at: Number(row.submitted_at)
    }));
  }

  /** Competition-before-drop order matches entry commands and decision workers. */
  public async lockDropMemberships(
    dropId: string,
    ctx: RequestContext
  ): Promise<NativeDropEntry[]> {
    if (!ctx.connection)
      throw new Error('Drop membership mutation requires a transaction');
    const initial = await this.findDropEntries(dropId, ctx);
    const ids = Array.from(
      new Set(initial.map((entry) => entry.competition_id))
    ).sort((a, b) => a.localeCompare(b));
    for (const id of ids)
      await this.rows(
        'lockCompetition',
        `select id from ${COMPETITIONS_TABLE} where id=:id for update`,
        { id },
        ctx
      );
    await this.rows(
      'lockDrop',
      `select id from ${DROPS_TABLE} where id=:dropId for update`,
      { dropId },
      ctx
    );
    // A locking read sees a membership committed while we waited for the drop,
    // even if a legacy caller already established a repeatable-read snapshot.
    const current = await this.findEntries(dropId, true, ctx);
    if (current.some((entry) => !ids.includes(entry.competition_id)))
      competitionConflict(
        'Competition membership changed. Retry the drop change'
      );
    return current;
  }

  public async assertDropAvailable(
    dropId: string,
    competitionId: string,
    ctx: RequestContext
  ): Promise<void> {
    const occupied = await this.rows<{ id: string }>(
      'assertDropAvailable',
      `select e.id from ${COMPETITION_ENTRIES_TABLE} e join ${COMPETITIONS_TABLE} c on c.id=e.competition_id
       where e.drop_id=:dropId limit 1`,
      { dropId, competitionId },
      ctx
    );
    if (occupied.length)
      competitionConflict(
        'A competition drop belongs to exactly one competition'
      );
  }

  public async countActive(
    competitionId: string,
    profileId: string,
    ctx: RequestContext
  ): Promise<number> {
    const [row] = await this.rows<{ count: number }>(
      'countActive',
      `select count(*) as count from ${COMPETITION_ENTRIES_TABLE} where competition_id=:competitionId and submitter_id=:profileId and status='ACTIVE'`,
      { competitionId, profileId },
      ctx
    );
    return Number(row?.count ?? 0);
  }

  public async findNominationStatuses(
    competitionId: string,
    profileId: string,
    excludedEntryId: string | null,
    ctx: RequestContext
  ): Promise<CompetitionEntryStatus[]> {
    const rows = await this.rows<{ status: CompetitionEntryStatus }>(
      'findNominationStatuses',
      `select distinct e.status from ${COMPETITION_ENTRIES_TABLE} e
       join ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} v on v.entry_id=e.id
         and v.version=(select max(newest.version) from ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} newest where newest.entry_id=e.id)
       join json_table(v.content,'$.metadata[*]' columns(data_key varchar(500) path '$.data_key', data_value varchar(500) path '$.data_value')) m
       where e.competition_id=:competitionId and (:excludedEntryId is null or e.id<>:excludedEntryId)
         and m.data_key='identity' and m.data_value=:profileId`,
      { competitionId, profileId, excludedEntryId },
      ctx
    );
    return rows.map((row) => row.status);
  }

  public async insert(
    entry: CompetitionEntry,
    ctx: RequestContext
  ): Promise<void> {
    await this.rows(
      'insert',
      `insert into ${COMPETITION_ENTRIES_TABLE}
      (id,wave_id,competition_id,drop_id,submitter_id,status,config_version,submitted_at,\`rank\`,won_at,decision_id)
      values (:id,:wave_id,:competition_id,:drop_id,:submitter_id,:status,:config_version,:submitted_at,:rank,:won_at,:decision_id)`,
      entry,
      ctx
    );
  }

  public async deleteEntry(
    entryId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (!ctx.connection)
      throw new Error('Entry deletion requires a transaction');
    for (const table of [
      COMPETITION_LEADERBOARD_ENTRIES_TABLE,
      COMPETITION_VOTES_TABLE,
      COMPETITION_VOTE_HISTORY_TABLE,
      COMPETITION_ENTRY_RUNTIME_TABLE,
      COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE
    ]) {
      await this.rows(
        'deleteEntryData',
        `delete from ${table} where entry_id=:entryId`,
        { entryId },
        ctx
      );
    }
    await this.rows(
      'deleteEntry',
      `delete from ${COMPETITION_ENTRIES_TABLE} where id=:entryId`,
      { entryId },
      ctx
    );
  }

  public async saveContent(
    entry: CompetitionEntry,
    content: CompetitionEntryContent,
    actorId: string,
    signature:
      | {
          message: string;
          signature: string;
          payload?: unknown;
          content?: unknown;
        }
      | undefined,
    ctx: RequestContext & { competitionContentObservedAt?: number }
  ): Promise<number> {
    const [version] = await this.rows<{ version: number }>(
      'nextContentVersion',
      `select coalesce(max(version),0)+1 as version from ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} where entry_id=:entryId`,
      { entryId: entry.id },
      ctx
    );
    await this.rows(
      'saveContent',
      `insert into ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} (entry_id,version,competition_id,drop_id,content,signature_message,signature,signed_payload,signed_content,actor_id,created_at)
      values (:entryId,:version,:competitionId,:dropId,:content,:message,:signature,:payload,:signedContent,:actorId,:now)`,
      {
        entryId: entry.id,
        version: Number(version.version),
        competitionId: entry.competition_id,
        dropId: entry.drop_id,
        content: JSON.stringify(content),
        message: signature?.message ?? null,
        signature: signature?.signature ?? null,
        payload:
          signature?.payload === undefined
            ? null
            : JSON.stringify(signature.payload),
        signedContent:
          signature?.content === undefined
            ? null
            : JSON.stringify(signature.content),
        actorId,
        now: ctx.competitionContentObservedAt ?? Date.now()
      },
      ctx
    );
    return Number(version.version);
  }

  public async getContent(
    entryId: string,
    ctx: RequestContext
  ): Promise<CompetitionEntryContent | null> {
    const [row] = await this.rows<{
      content: CompetitionEntryContent | string;
    }>(
      'getContent',
      `select content from ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} where entry_id=:entryId order by version desc limit 1`,
      { entryId },
      ctx
    );
    if (!row) return null;
    return typeof row.content === 'string'
      ? (JSON.parse(row.content) as CompetitionEntryContent)
      : row.content;
  }

  public async isContentSuppressed(
    dropId: string,
    content: CompetitionEntryContent,
    ctx: RequestContext
  ): Promise<boolean> {
    // The shared drop may since have been edited. Its current visibility alone
    // cannot authorize publishing an older entry-owned revision.
    const revision = moderationFingerprint({
      title: content.title,
      parts: content.parts.map((part) => ({ content: part.content }))
    });
    const rows = await this.rows<{ id: string }>(
      'isContentSuppressed',
      `select id from ${CONTENT_MODERATION_ITEMS_TABLE}
       where subject_type='DROP' and (subject_id=:dropId or published_subject_id=:dropId)
       and json_unquote(json_extract(scope,'$.published_revision'))=:revision
       and (suppressed=true or \`override\`='BLOCK') limit 1`,
      { dropId, revision },
      ctx
    );
    return rows.length > 0;
  }

  public async loadDropContent(
    drop: DropEntity,
    ctx: RequestContext
  ): Promise<CompetitionEntryContent> {
    const params = { dropId: drop.id };
    const parts = await this.rows<DropPartEntity>(
      'contentParts',
      `select * from ${DROPS_PARTS_TABLE} where drop_id=:dropId order by drop_part_id`,
      params,
      ctx
    );
    const media = await this.rows<DropMediaEntity>(
      'contentMedia',
      `select * from ${DROP_MEDIA_TABLE} where drop_id=:dropId order by id`,
      params,
      ctx
    );
    const attachments = await this.rows<{
      drop_part_id: number;
      attachment_id: string;
    }>(
      'contentAttachments',
      `select drop_part_id,attachment_id from ${DROP_ATTACHMENTS_TABLE} where drop_id=:dropId order by drop_part_id,attachment_id`,
      params,
      ctx
    );
    const metadata = await this.rows<
      CompetitionEntryContent['metadata'][number]
    >(
      'contentMetadata',
      `select data_key,data_value from ${DROP_METADATA_TABLE} where drop_id=:dropId order by id`,
      params,
      ctx
    );
    const referenced_nfts = await this.rows<
      CompetitionEntryContent['referenced_nfts'][number]
    >(
      'contentNfts',
      `select contract,token,name from ${DROP_REFERENCED_NFTS_TABLE} where drop_id=:dropId order by id`,
      params,
      ctx
    );
    const mentioned_users = await this.rows<{
      handle: string;
      profile_id: string;
    }>(
      'contentMentions',
      `select handle_in_content as handle, mentioned_profile_id as profile_id from ${DROPS_MENTIONS_TABLE} where drop_id=:dropId order by id`,
      params,
      ctx
    );
    const mentioned_waves = await this.rows<
      CompetitionEntryContent['mentioned_waves'][number]
    >(
      'contentWaveMentions',
      `select wave_id,wave_name_in_content from ${DROP_MENTIONED_WAVES_TABLE} where drop_id=:dropId order by id`,
      params,
      ctx
    );
    const groups = await this.rows<{
      mentioned_group: CompetitionEntryContent['mentioned_groups'][number];
    }>(
      'contentGroups',
      `select mentioned_group from ${DROP_MENTIONED_GROUPS_TABLE} where drop_id=:dropId order by mentioned_group`,
      params,
      ctx
    );
    return {
      wave_id: drop.wave_id,
      title: drop.title,
      hide_link_preview: Boolean(drop.hide_link_preview),
      reply_to: drop.reply_to_drop_id
        ? {
            drop_id: drop.reply_to_drop_id,
            drop_part_id: Number(drop.reply_to_part_id)
          }
        : null,
      metadata,
      referenced_nfts,
      mentioned_users,
      mentioned_waves,
      mentioned_groups: groups.map((row) => row.mentioned_group),
      parts: parts.map((part) => ({
        content: part.content,
        quoted_drop: part.quoted_drop_id
          ? {
              drop_id: part.quoted_drop_id,
              drop_part_id: Number(part.quoted_drop_part_id)
            }
          : null,
        media: media
          .filter(
            (item) => Number(item.drop_part_id) === Number(part.drop_part_id)
          )
          .map((item) => ({
            url: item.url,
            mime_type: item.mime_type,
            media_upload_id: item.media_upload_id
          })),
        attachments: attachments
          .filter(
            (item) => Number(item.drop_part_id) === Number(part.drop_part_id)
          )
          .map((item) => ({ attachment_id: item.attachment_id }))
      }))
    };
  }
}

export const competitionEntryRepository = new CompetitionEntryRepository(
  dbSupplier
);
