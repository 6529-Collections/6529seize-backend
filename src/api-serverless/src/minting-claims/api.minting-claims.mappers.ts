import type { MintingClaim } from '@/api/generated/models/MintingClaim';
import type { MintingClaimRow } from '@/api/minting-claims/api.minting-claims.db';
import { Logger } from '@/logging';

function safeParseJson<T>(raw: string | null, fallback: T, label: string): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    Logger.get('api.minting-claims.mappers').warn(`Failed to parse ${label}`, {
      raw: raw.slice(0, 200),
      err
    });
    return fallback;
  }
}

export function rowToMintingClaim(row: MintingClaimRow): MintingClaim {
  const editionSize =
    row.edition_size == null ? undefined : Number(row.edition_size);

  return {
    drop_id: row.drop_id,
    contract: row.contract,
    claim_id: row.claim_id,
    image_location: row.image_location ?? undefined,
    animation_location: row.animation_location ?? undefined,
    metadata_location: row.metadata_location ?? undefined,
    media_uploading: !!row.media_uploading,
    edition_size: editionSize,
    description: row.description,
    name: row.name,
    image_url: row.image_url ?? undefined,
    external_url: row.external_url ?? undefined,
    attributes: safeParseJson(row.attributes, [], 'attributes'),
    image_details: safeParseJson(row.image_details, undefined, 'image_details'),
    animation_url: row.animation_url ?? undefined,
    animation_details: safeParseJson(
      row.animation_details,
      undefined,
      'animation_details'
    )
  };
}
