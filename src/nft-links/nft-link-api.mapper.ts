import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { ApiNftLinkMediaPreviewStatusEnum } from '@/api/generated/models/ApiNftLinkMediaPreview';
import { NftLinkEntity } from '@/entities/INftLink';

export function mapNftLinkEntityToApiLink(
  entity: NftLinkEntity
): ApiNftLinkData {
  return {
    canonical_id: entity.canonical_id,
    platform: entity.platform,
    chain: entity.chain,
    contract: entity.contract,
    token: entity.token,
    name: entity.full_data?.asset?.title ?? null,
    description: entity.full_data?.asset?.description ?? null,
    media_uri: entity.media_uri,
    last_error_message: entity.last_error_message,
    price: entity.price?.toString() ?? null,
    last_successfully_updated: entity.last_successfully_updated,
    failed_since: entity.failed_since,
    media_preview: entity.media_preview_status
      ? {
          status:
            entity.media_preview_status as ApiNftLinkMediaPreviewStatusEnum,
          kind: entity.media_preview_kind,
          card_url: entity.media_preview_card_url,
          thumb_url: entity.media_preview_thumb_url,
          small_url: entity.media_preview_small_url,
          width: entity.media_preview_width,
          height: entity.media_preview_height,
          mime_type: entity.media_preview_mime_type
        }
      : null
  };
}
