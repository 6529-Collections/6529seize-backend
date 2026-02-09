import {
  fetchMaxSeasonId,
  fetchMemeClaimByMemeId,
  updateMemeClaim,
  type MemeClaimRow
} from '@/api/memes-minting/api.memes-minting.db';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import type { MemeClaimUpdateRequest } from '@/api/generated/models/MemeClaimUpdateRequest';
import {
  computeImageDetails,
  computeAnimationDetailsVideo,
  computeAnimationDetailsGlb,
  animationDetailsHtml
} from '@/meme-claims/media-inspector';

const MIN_EDITION_SIZE = 300;

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

function inferAnimationKind(
  animationUrl: string,
  existing: { format?: string } | undefined
): 'HTML' | 'GLB' | 'VIDEO' {
  const lower = animationUrl.toLowerCase();
  if (lower.startsWith('data:text/html')) return 'HTML';
  if (lower.endsWith('.glb')) return 'GLB';
  if (lower.endsWith('.mp4') || lower.endsWith('.mov')) return 'VIDEO';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'HTML';
  if (existing?.format === 'HTML') return 'HTML';
  if (existing?.format === 'GLB') return 'GLB';
  return 'VIDEO';
}

async function applyImageFromBody(
  body: MemeClaimUpdateRequest,
  existing: MemeClaimRow,
  updates: MemeClaimUpdates
): Promise<void> {
  if (body.image_url === undefined) return;
  if (body.image_url && typeof body.image_url === 'string') {
    const urlChanged = (existing.image_url ?? '').trim() !== body.image_url;
    try {
      updates.image_details = await computeImageDetails(body.image_url);
    } catch {
      if (urlChanged) {
        updates.image_details = null;
      }
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
  const urlChanged = (existing.animation_url ?? '').trim() !== animationUrl;
  try {
    const kind = inferAnimationKind(animationUrl, existingDetails);
    if (kind === 'HTML') {
      updates.animation_details = animationDetailsHtml();
    } else if (kind === 'GLB') {
      updates.animation_details =
        await computeAnimationDetailsGlb(animationUrl);
    } else {
      updates.animation_details =
        await computeAnimationDetailsVideo(animationUrl);
    }
  } catch {
    if (urlChanged) {
      updates.animation_details = null;
    }
  }
}

export async function buildUpdatesForClaimPatch(
  body: MemeClaimUpdateRequest,
  existing: MemeClaimRow
): Promise<MemeClaimUpdates> {
  const updates: MemeClaimUpdates = {};
  let shouldResetArweaveSyncedAt = false;
  if (body.season !== undefined) {
    const maxSeason = await fetchMaxSeasonId();
    const requested = Number(body.season);
    const minSeason = 1;
    const requiredMinSeason = Math.max(minSeason, maxSeason);
    if (
      !Number.isInteger(requested) ||
      requested < requiredMinSeason ||
      requested > requiredMinSeason + 1
    ) {
      throw new BadRequestException(
        `season must be ${requiredMinSeason} or ${requiredMinSeason + 1} (current max season is ${maxSeason}), got ${body.season}`
      );
    }
    updates.season = requested;
    shouldResetArweaveSyncedAt = true;
  }
  if (body.image_location !== undefined)
    updates.image_location = body.image_location;
  if (body.animation_location !== undefined)
    updates.animation_location = body.animation_location;
  if (body.metadata_location !== undefined)
    updates.metadata_location = body.metadata_location;
  if (body.edition_size !== undefined) {
    if (
      body.edition_size !== null &&
      (!Number.isInteger(body.edition_size) ||
        body.edition_size < MIN_EDITION_SIZE)
    ) {
      throw new BadRequestException(
        `edition_size must be at least ${MIN_EDITION_SIZE}`
      );
    }
    updates.edition_size = body.edition_size;
    shouldResetArweaveSyncedAt = true;
  }
  if (body.description !== undefined) {
    updates.description = body.description;
    shouldResetArweaveSyncedAt = true;
  }
  if (body.name !== undefined) {
    updates.name = body.name;
    shouldResetArweaveSyncedAt = true;
  }
  if (body.image_url !== undefined) {
    updates.image_url = body.image_url;
    shouldResetArweaveSyncedAt = true;
  }
  if (body.attributes !== undefined) {
    updates.attributes = body.attributes;
    shouldResetArweaveSyncedAt = true;
  }
  if (body.animation_url !== undefined)
    updates.animation_url = body.animation_url;
  if (body.image_url !== undefined) {
    await applyImageFromBody(body, existing, updates);
  }
  if (body.animation_url !== undefined) {
    await applyAnimationFromBody(body, existing, updates);
    shouldResetArweaveSyncedAt = true;
  }
  if (shouldResetArweaveSyncedAt) {
    updates.arweave_synced_at = null;
  }
  return updates;
}

export async function patchMemeClaim(
  memeId: number,
  body: MemeClaimUpdateRequest
): Promise<MemeClaimRow | null> {
  const existing = await fetchMemeClaimByMemeId(memeId);
  if (existing === null) return null;
  if (existing.media_uploading) {
    throw new CustomApiCompliantException(
      409,
      'Claim media upload in progress; updates are temporarily blocked'
    );
  }
  const updates = await buildUpdatesForClaimPatch(body, existing);
  await updateMemeClaim(memeId, updates);
  return fetchMemeClaimByMemeId(memeId);
}
