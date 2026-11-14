import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE,
  DROP_MEDIA_TABLE,
  DROP_MEDIA_UPLOADS_TABLE,
  DROP_METADATA_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  MINTING_CLAIMS_TABLE,
  WAVES_ARCHIVE_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export interface NonChatDropRow {
  readonly serial_no: number | string;
  readonly id: string;
  readonly drop_type: string;
  readonly reply_to_drop_id: string | null;
}

export interface DropTextRow {
  readonly drop_id: string;
  readonly text: unknown;
}

export interface UploadPurposeRow {
  readonly id: string;
  readonly public_key: string;
  readonly public_url: string;
  readonly purpose: string | null;
}

export interface MintingClaimMediaRow {
  readonly drop_id: string;
  readonly image_url: string | null;
  readonly animation_url: string | null;
}

export interface DropMediaUrlRow {
  readonly id: number | string;
  readonly drop_id: string;
  readonly url: string;
}

export interface DropMediaCandidateRow {
  readonly id: number | string;
  readonly drop_id: string;
  readonly url: string;
  readonly mime_type: string;
  readonly media_upload_id: string | null;
  /** Null when the drop no longer exists. */
  readonly joined_drop_id: string | null;
  readonly drop_type: string | null;
  readonly reply_to_drop_id: string | null;
  readonly is_direct_message: number | boolean | null;
  readonly upload_purpose: string | null;
  /** 1 when the drop is a native competition entry, whatever its drop type. */
  readonly has_competition_entry: number | string | null;
}

export interface WavePictureRow {
  readonly page_cursor: number | string;
  readonly wave_id: string;
  readonly picture: string | null;
  readonly is_direct_message: number | boolean | null;
}

/**
 * Read-only queries for the chat media backfill. Every listing pages by an
 * indexed, monotonically increasing cursor so a run can resume.
 */
export class ChatMediaBackfillDb extends LazyDbAccessCompatibleService {
  async findNonChatDropsAfter(
    afterSerialNo: number,
    limit: number
  ): Promise<NonChatDropRow[]> {
    return this.db.execute<NonChatDropRow>(
      `select serial_no, id, drop_type, reply_to_drop_id
       from ${DROPS_TABLE}
       where serial_no > :afterSerialNo and drop_type <> :chat
       order by serial_no asc
       limit :limit`,
      { afterSerialNo, chat: DropType.CHAT, limit }
    );
  }

  async findCompetitionEntryDropsAfter(
    afterId: string,
    limit: number
  ): Promise<{ id: string; drop_id: string }[]> {
    return this.db.execute(
      `select id, drop_id
       from ${COMPETITION_ENTRIES_TABLE}
       where id > :afterId
       order by id asc
       limit :limit`,
      { afterId, limit }
    );
  }

  async findMediaUrlsOfDrops(dropIds: string[]): Promise<DropTextRow[]> {
    if (!dropIds.length) return [];
    return this.db.execute<DropTextRow>(
      `select drop_id, url as text from ${DROP_MEDIA_TABLE} where drop_id in (:dropIds)`,
      { dropIds }
    );
  }

  /** Metadata values, part contents and native entry content of the drops. */
  async findTextsOfDrops(dropIds: string[]): Promise<DropTextRow[]> {
    if (!dropIds.length) return [];
    const [metadata, parts, entryContent] = await Promise.all([
      this.db.execute<DropTextRow>(
        `select drop_id, data_value as text from ${DROP_METADATA_TABLE} where drop_id in (:dropIds)`,
        { dropIds }
      ),
      this.db.execute<DropTextRow>(
        `select drop_id, content as text from ${DROPS_PARTS_TABLE}
         where drop_id in (:dropIds) and content is not null`,
        { dropIds }
      ),
      this.db.execute<DropTextRow>(
        `select drop_id,
           concat_ws(' ', cast(content as char), cast(signed_content as char),
             cast(signed_payload as char)) as text
         from ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE}
         where drop_id in (:dropIds)`,
        { dropIds }
      )
    ]);
    return [...metadata, ...parts, ...entryContent];
  }

  async findUploadsAfter(
    afterId: string,
    limit: number
  ): Promise<UploadPurposeRow[]> {
    return this.db.execute<UploadPurposeRow>(
      `select id, public_key, public_url, purpose
       from ${DROP_MEDIA_UPLOADS_TABLE}
       where id > :afterId
       order by id asc
       limit :limit`,
      { afterId, limit }
    );
  }

  async findMintingClaimMediaAfter(
    afterDropId: string,
    limit: number
  ): Promise<MintingClaimMediaRow[]> {
    return this.db.execute<MintingClaimMediaRow>(
      `select drop_id, image_url, animation_url
       from ${MINTING_CLAIMS_TABLE}
       where drop_id > :afterDropId
       order by drop_id asc
       limit :limit`,
      { afterDropId, limit }
    );
  }

  async findOrphanDropMediaAfter(
    afterId: number,
    limit: number
  ): Promise<{ rows: DropMediaUrlRow[]; lastId: number | null }> {
    const page = await this.db.execute<DropMediaUrlRow & { orphan: number }>(
      `select dm.id, dm.drop_id, dm.url, (d.id is null) as orphan
       from ${DROP_MEDIA_TABLE} dm
       left join ${DROPS_TABLE} d on d.id = dm.drop_id
       where dm.id > :afterId
       order by dm.id asc
       limit :limit`,
      { afterId, limit }
    );
    const last = page[page.length - 1];
    return {
      rows: page.filter((row) => Number(row.orphan) === 1),
      lastId: last ? Number(last.id) : null
    };
  }

  async findDropMediaCandidatesAfter(
    afterId: number,
    limit: number
  ): Promise<DropMediaCandidateRow[]> {
    return this.db.execute<DropMediaCandidateRow>(
      `select dm.id, dm.drop_id, dm.url, dm.mime_type, dm.media_upload_id,
         d.id as joined_drop_id, d.drop_type, d.reply_to_drop_id,
         w.is_direct_message, u.purpose as upload_purpose,
         exists (
           select 1 from ${COMPETITION_ENTRIES_TABLE} ce where ce.drop_id = dm.drop_id
         ) as has_competition_entry
       from ${DROP_MEDIA_TABLE} dm
       left join ${DROPS_TABLE} d on d.id = dm.drop_id
       left join ${WAVES_TABLE} w on w.id = d.wave_id
       left join ${DROP_MEDIA_UPLOADS_TABLE} u on u.id = dm.media_upload_id
       where dm.id > :afterId
       order by dm.id asc
       limit :limit`,
      { afterId, limit }
    );
  }

  async findWavePicturesAfter(
    afterSerialNo: number,
    limit: number
  ): Promise<WavePictureRow[]> {
    return this.db.execute<WavePictureRow>(
      `select serial_no as page_cursor, id as wave_id, picture, is_direct_message
       from ${WAVES_TABLE}
       where serial_no > :afterSerialNo
       order by serial_no asc
       limit :limit`,
      { afterSerialNo, limit }
    );
  }

  async findArchivedWavePicturesAfter(
    afterArchiveId: number,
    limit: number
  ): Promise<WavePictureRow[]> {
    return this.db.execute<WavePictureRow>(
      `select archive_id as page_cursor, id as wave_id, picture, is_direct_message
       from ${WAVES_ARCHIVE_TABLE}
       where archive_id > :afterArchiveId
       order by archive_id asc
       limit :limit`,
      { afterArchiveId, limit }
    );
  }
}

export const chatMediaBackfillDb = new ChatMediaBackfillDb(dbSupplier);
