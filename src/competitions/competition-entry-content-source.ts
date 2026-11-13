import type { CompetitionEntryContent } from '@/competitions/competition-entry.repository';
import type {
  DropEntity,
  DropPartEntity,
  DropMediaEntity
} from '@/entities/IDrop';

export type LegacyDropContentRelations = {
  parts: readonly Pick<
    DropPartEntity,
    'drop_part_id' | 'content' | 'quoted_drop_id' | 'quoted_drop_part_id'
  >[];
  media: readonly Pick<
    DropMediaEntity,
    'drop_part_id' | 'url' | 'mime_type' | 'media_upload_id'
  >[];
  attachments: readonly { drop_part_id: number; attachment_id: string }[];
  metadata: CompetitionEntryContent['metadata'];
  referenced_nfts: CompetitionEntryContent['referenced_nfts'];
  mentioned_users: CompetitionEntryContent['mentioned_users'];
  mentioned_waves: CompetitionEntryContent['mentioned_waves'];
  groups: readonly {
    mentioned_group: CompetitionEntryContent['mentioned_groups'][number];
  }[];
};

/** Keep the single-drop and migration page projections byte-for-byte equivalent. */
export function assembleLegacyDropContent(
  drop: DropEntity,
  relations: LegacyDropContentRelations
): CompetitionEntryContent {
  const {
    parts,
    media,
    attachments,
    metadata,
    referenced_nfts,
    mentioned_users,
    mentioned_waves,
    groups
  } = relations;
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
