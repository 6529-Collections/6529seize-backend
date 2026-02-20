import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
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
    failed_since: entity.failed_since
  };
}
