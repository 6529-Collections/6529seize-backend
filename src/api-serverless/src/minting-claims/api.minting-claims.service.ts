import {
  fetchMaxSeasonId,
  fetchMintingClaimByClaimId,
  updateMintingClaim,
  type MintingClaimRow
} from '@/api/minting-claims/api.minting-claims.db';
import { upsertAutomaticAirdropsForPhase } from '@/api/distributions/api.distributions.service';
import { DISTRIBUTION_PHASE_AIRDROP_TEAM } from '@/airdrop-phases';
import { MEMES_CONTRACT, TEAM_TABLE } from '@/constants';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import type { MintingClaimUpdateRequest } from '@/api/generated/models/MintingClaimUpdateRequest';
import {
  computeImageDetails,
  computeAnimationDetailsVideo,
  computeAnimationDetailsGlb,
  animationDetailsHtml
} from '@/minting-claims/media-inspector';
import { sqlExecutor } from '@/sql-executor';
import { ethers } from 'ethers';

const MIN_EDITION_SIZE = 300;
const TYPE_SEASON_TRAIT = 'Type - Season';

export type MintingClaimUpdates = Parameters<typeof updateMintingClaim>[2];

const TEAM_COLLECTION_RESERVE = 'Reserve';

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

function validateRequestedSeason(
  requestedSeason: number,
  maxSeason: number
): number {
  const requested = Number(requestedSeason);
  const minSeason = 1;
  const requiredMinSeason = Math.max(minSeason, maxSeason);
  if (
    !Number.isInteger(requested) ||
    requested < requiredMinSeason ||
    requested > requiredMinSeason + 1
  ) {
    throw new BadRequestException(
      `Season must be ${requiredMinSeason} or ${requiredMinSeason + 1} (current max season is ${maxSeason}), got ${requestedSeason}`
    );
  }
  return requested;
}

function extractSeasonFromAttributes(attributes: unknown): number | null {
  if (!Array.isArray(attributes)) {
    return null;
  }

  const seasonAttribute = attributes.find((attribute) => {
    if (typeof attribute !== 'object' || attribute == null) {
      return false;
    }
    const traitType = (attribute as { trait_type?: unknown }).trait_type;
    return traitType === TYPE_SEASON_TRAIT;
  }) as { value?: unknown } | undefined;

  if (!seasonAttribute) {
    return null;
  }

  const value = seasonAttribute.value;
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeAttributesWithSeason(
  attributes: unknown,
  season: number
): unknown[] {
  if (!Array.isArray(attributes)) {
    return [];
  }

  const filtered = attributes.filter((attribute) => {
    if (typeof attribute !== 'object' || attribute == null) {
      return true;
    }
    const traitType = (attribute as { trait_type?: unknown }).trait_type;
    return traitType !== TYPE_SEASON_TRAIT;
  });

  filtered.push({
    trait_type: TYPE_SEASON_TRAIT,
    value: season,
    display_type: 'number'
  });

  return filtered;
}

function applyEditionSizeUpdate(
  body: MintingClaimUpdateRequest,
  updates: MintingClaimUpdates,
  isMemesContract: boolean
): boolean {
  if (body.edition_size === undefined) return false;
  if (body.edition_size !== null && !Number.isInteger(body.edition_size)) {
    throw new BadRequestException('edition_size must be an integer');
  }
  if (
    isMemesContract &&
    body.edition_size !== null &&
    body.edition_size < MIN_EDITION_SIZE
  ) {
    throw new BadRequestException(
      `edition_size must be at least ${MIN_EDITION_SIZE}`
    );
  }
  updates.edition_size = body.edition_size;
  return true;
}

async function applyImageFromBody(
  body: MintingClaimUpdateRequest,
  existing: MintingClaimRow,
  updates: MintingClaimUpdates
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
  body: MintingClaimUpdateRequest,
  existing: MintingClaimRow,
  updates: MintingClaimUpdates
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

async function applyAttributesFromBody(
  body: MintingClaimUpdateRequest,
  updates: MintingClaimUpdates,
  isMemesContract: boolean
): Promise<boolean> {
  if (body.attributes === undefined) {
    return false;
  }

  if (!isMemesContract) {
    updates.attributes = body.attributes;
    return true;
  }

  const requestedSeason = extractSeasonFromAttributes(body.attributes);
  if (requestedSeason == null) {
    throw new BadRequestException(
      `attributes must include a numeric "${TYPE_SEASON_TRAIT}" trait for MEMES contract`
    );
  }

  const validatedSeason = validateRequestedSeason(
    requestedSeason,
    await fetchMaxSeasonId()
  );

  updates.attributes = normalizeAttributesWithSeason(
    body.attributes,
    validatedSeason
  );

  return true;
}

export async function buildUpdatesForClaimPatch(
  body: MintingClaimUpdateRequest,
  existing: MintingClaimRow,
  isMemesContract: boolean
): Promise<MintingClaimUpdates> {
  const updates: MintingClaimUpdates = {};
  let shouldResetSyncState = false;

  if (body.description !== undefined) {
    updates.description = body.description;
    shouldResetSyncState = true;
  }

  if (body.name !== undefined) {
    updates.name = body.name;
    shouldResetSyncState = true;
  }

  if (body.image_url !== undefined) {
    updates.image_url = body.image_url;
    shouldResetSyncState = true;
  }

  if (await applyAttributesFromBody(body, updates, isMemesContract)) {
    shouldResetSyncState = true;
  }

  if (body.animation_url !== undefined) {
    updates.animation_url = body.animation_url;
    shouldResetSyncState = true;
  }

  shouldResetSyncState =
    applyEditionSizeUpdate(body, updates, isMemesContract) ||
    shouldResetSyncState;

  if (body.image_url !== undefined) {
    await applyImageFromBody(body, existing, updates);
  }

  if (body.animation_url !== undefined) {
    await applyAnimationFromBody(body, existing, updates);
    shouldResetSyncState = true;
  }

  if (shouldResetSyncState) {
    updates.metadata_location = null;
  }

  return updates;
}

export async function patchMintingClaim(
  contract: string,
  claimId: number,
  body: MintingClaimUpdateRequest,
  isMemesContract: boolean
): Promise<MintingClaimRow | null> {
  const existing = await fetchMintingClaimByClaimId(contract, claimId);
  if (existing === null) return null;

  if (existing.media_uploading) {
    throw new CustomApiCompliantException(
      409,
      'Claim media upload in progress; updates are temporarily blocked'
    );
  }

  const updates = await buildUpdatesForClaimPatch(
    body,
    existing,
    isMemesContract
  );
  await updateMintingClaim(contract, claimId, updates);

  const updated = await fetchMintingClaimByClaimId(contract, claimId);
  if (updated === null) {
    return null;
  }

  if (isMemesContract && body.edition_size !== undefined) {
    await syncReserveTeamAirdrops(claimId, updated.edition_size);
  }

  return fetchMintingClaimByClaimId(contract, claimId);
}

async function fetchReserveTeamWallets(): Promise<string[]> {
  const rows = await sqlExecutor.execute<{ wallet: string }>(
    `SELECT wallet FROM ${TEAM_TABLE} WHERE collection = :collection`,
    { collection: TEAM_COLLECTION_RESERVE }
  );
  return rows
    .map((row) => row.wallet?.trim().toLowerCase())
    .filter((wallet): wallet is string => !!wallet && ethers.isAddress(wallet));
}

async function syncReserveTeamAirdrops(
  claimId: number,
  editionSize: number | null
): Promise<void> {
  if (editionSize == null) {
    return;
  }
  const reserveWallets = await fetchReserveTeamWallets();
  if (reserveWallets.length === 0) {
    return;
  }
  const reserveCount = Math.round(editionSize * 0.1);
  if (reserveCount <= 0) {
    return;
  }
  await upsertAutomaticAirdropsForPhase(
    MEMES_CONTRACT,
    claimId,
    DISTRIBUTION_PHASE_AIRDROP_TEAM,
    reserveWallets.map((address) => ({ address, count: reserveCount })),
    undefined,
    false
  );
}
