import {
  fetchMemeClaimByMemeId,
  updateMemeClaim,
  type MemeClaimRow
} from '@/api/memes-minting/api.memes-minting.db';
import type { MemeClaimUpdateRequest } from '@/api/generated/models/MemeClaimUpdateRequest';
import {
  computeImageDetails,
  computeAnimationDetailsVideo,
  computeAnimationDetailsGlb,
  animationDetailsHtml
} from '@/meme-claims/media-inspector';

export type MemeClaimUpdates = Parameters<typeof updateMemeClaim>[1];

function parseExistingAnimationFormat(
  animationDetails: string | null
): { format?: string } | undefined {
  if (animationDetails == null) return undefined;
  try {
    return JSON.parse(animationDetails) as { format?: string };
  } catch {
    return undefined;
  }
}

async function applyImageFromBody(
  body: MemeClaimUpdateRequest,
  updates: MemeClaimUpdates
): Promise<void> {
  if (body.image === undefined) return;
  if (body.image && typeof body.image === 'string') {
    try {
      updates.image_details = await computeImageDetails(body.image);
    } catch {
      // keep existing on compute failure
    }
  } else {
    updates.image_details = null;
  }
}

async function applyAnimationFromBody(
  body: MemeClaimUpdateRequest,
  existing: MemeClaimRow,
  updates: MemeClaimUpdates
): Promise<void> {
  if (body.animation_url === undefined) return;
  const hasValidAnimationUrl =
    typeof body.animation_url === 'string' && body.animation_url.length > 0;
  if (!hasValidAnimationUrl) {
    updates.animation_details = null;
    return;
  }
  const animationUrl = body.animation_url as string;
  const existingDetails = parseExistingAnimationFormat(
    existing.animation_details
  );
  try {
    if (existingDetails?.format === 'HTML') {
      updates.animation_details = animationDetailsHtml();
    } else if (
      animationUrl.toLowerCase().endsWith('.glb') ||
      existingDetails?.format === 'GLB'
    ) {
      updates.animation_details = await computeAnimationDetailsGlb(
        animationUrl
      );
    } else {
      updates.animation_details = await computeAnimationDetailsVideo(
        animationUrl
      );
    }
  } catch {
    // keep existing on compute failure
  }
}

export async function buildUpdatesForClaimPatch(
  body: MemeClaimUpdateRequest,
  existing: MemeClaimRow
): Promise<MemeClaimUpdates> {
  const updates: MemeClaimUpdates = {};
  if (body.image_location !== undefined)
    updates.image_location = body.image_location;
  if (body.animation_location !== undefined)
    updates.animation_location = body.animation_location;
  if (body.metadata_location !== undefined)
    updates.metadata_location = body.metadata_location;
  if (body.edition_size !== undefined) updates.edition_size = body.edition_size;
  if (body.description !== undefined) updates.description = body.description;
  if (body.name !== undefined) updates.name = body.name;
  if (body.image !== undefined) updates.image = body.image;
  if (body.attributes !== undefined) updates.attributes = body.attributes;
  if (body.animation_url !== undefined)
    updates.animation_url = body.animation_url;
  if (body.image !== undefined) {
    await applyImageFromBody(body, updates);
  }
  if (body.animation_url !== undefined) {
    await applyAnimationFromBody(body, existing, updates);
  }
  updates.arweave_synced_at = null;
  return updates;
}

export async function patchMemeClaim(
  memeId: number,
  body: MemeClaimUpdateRequest
): Promise<MemeClaimRow | null> {
  const existing = await fetchMemeClaimByMemeId(memeId);
  if (existing === null) return null;
  const updates = await buildUpdatesForClaimPatch(body, existing);
  await updateMemeClaim(memeId, updates);
  return fetchMemeClaimByMemeId(memeId);
}
