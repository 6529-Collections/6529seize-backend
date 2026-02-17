import {
  DISTRIBUTION_TABLE,
  MEMES_CLAIMS_TABLE,
  MEMES_EXTENDED_DATA_TABLE,
  MEMES_SEASONS_TABLE,
  MINTING_MERKLE_PROOFS_TABLE,
  MINTING_MERKLE_ROOTS_TABLE
} from '@/constants';
import { DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES } from '@/airdrop-phases';
import { sqlExecutor } from '@/sql-executor';
import type { AllowlistMerkleProofItem } from './allowlist-merkle';

type StoredMerkleProofs = string | AllowlistMerkleProofItem[] | null;

function isAllowlistMerkleProofItem(
  value: unknown
): value is AllowlistMerkleProofItem {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    merkleProof?: unknown;
    value?: unknown;
  };
  return (
    Array.isArray(candidate.merkleProof) &&
    candidate.merkleProof.every((entry) => typeof entry === 'string') &&
    typeof candidate.value === 'number'
  );
}

function parseStoredMerkleProofs(
  raw: StoredMerkleProofs
): AllowlistMerkleProofItem[] {
  if (raw == null) return [];
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isAllowlistMerkleProofItem);
}

export async function deleteMintingMerkleForPhase(
  contract: string,
  cardId: number,
  phase: string,
  wrappedConnection?: any
): Promise<void> {
  const opts = wrappedConnection ? { wrappedConnection } : {};
  const contractLower = contract.toLowerCase();
  const roots = await sqlExecutor.execute<{ merkle_root: string }>(
    `SELECT merkle_root FROM ${MINTING_MERKLE_ROOTS_TABLE} WHERE contract = :contract AND card_id = :cardId AND phase = :phase`,
    { contract: contractLower, cardId, phase },
    opts
  );
  const merkleRoots = roots.map((r) => r.merkle_root).filter(Boolean);
  if (merkleRoots.length > 0) {
    await sqlExecutor.execute(
      `DELETE FROM ${MINTING_MERKLE_PROOFS_TABLE} WHERE merkle_root IN (:merkleRoots)`,
      { merkleRoots },
      opts
    );
  }
  await sqlExecutor.execute(
    `DELETE FROM ${MINTING_MERKLE_ROOTS_TABLE} WHERE contract = :contract AND card_id = :cardId AND phase = :phase`,
    { contract: contractLower, cardId, phase },
    opts
  );
}

export async function insertMintingMerkleRoot(
  contract: string,
  cardId: number,
  phase: string,
  merkleRoot: string,
  wrappedConnection?: any
): Promise<void> {
  await sqlExecutor.execute(
    `INSERT INTO ${MINTING_MERKLE_ROOTS_TABLE} (card_id, contract, phase, merkle_root) VALUES (:cardId, :contract, :phase, :merkleRoot)`,
    {
      cardId,
      contract: contract.toLowerCase(),
      phase,
      merkleRoot
    },
    wrappedConnection ? { wrappedConnection } : {}
  );
}

export async function insertMintingMerkleProofs(
  merkleRoot: string,
  proofsByAddress: Record<string, AllowlistMerkleProofItem[]>,
  wrappedConnection?: any
): Promise<void> {
  const entries = Object.entries(proofsByAddress);
  if (entries.length === 0) return;
  const opts = wrappedConnection ? { wrappedConnection } : {};
  const batchSize = 200;
  for (let start = 0; start < entries.length; start += batchSize) {
    const chunk = entries.slice(start, start + batchSize);
    const params: Record<string, unknown> = { merkleRoot };
    const placeholders = chunk
      .map((_, i) => `(:merkleRoot, :address_${i}, :proofs_${i})`)
      .join(', ');
    chunk.forEach(([address, proofs], i) => {
      params[`address_${i}`] = address.toLowerCase();
      params[`proofs_${i}`] = JSON.stringify(proofs);
    });
    await sqlExecutor.execute(
      `INSERT INTO ${MINTING_MERKLE_PROOFS_TABLE} (merkle_root, address, proofs) VALUES ${placeholders}`,
      params,
      opts
    );
  }
}

export interface MintingMerkleProofRow {
  proofs: StoredMerkleProofs;
}

export async function fetchMintingMerkleProofs(
  merkleRoot: string,
  address: string
): Promise<AllowlistMerkleProofItem[] | null> {
  const addressLower = address.toLowerCase();
  const rows = await sqlExecutor.execute<MintingMerkleProofRow>(
    `SELECT proofs FROM ${MINTING_MERKLE_PROOFS_TABLE} WHERE merkle_root = :merkleRoot AND address = :address LIMIT 1`,
    { merkleRoot, address: addressLower }
  );
  if (rows.length === 0) return null;
  return parseStoredMerkleProofs(rows[0].proofs);
}

export interface MintingMerkleProofByAddressRow {
  address: string;
  proofs: StoredMerkleProofs;
}

export async function fetchAllMintingMerkleProofsForRoot(
  merkleRoot: string
): Promise<{ address: string; proofs: AllowlistMerkleProofItem[] }[]> {
  const rows = await sqlExecutor.execute<MintingMerkleProofByAddressRow>(
    `SELECT address, proofs FROM ${MINTING_MERKLE_PROOFS_TABLE} WHERE merkle_root = :merkleRoot ORDER BY address ASC`,
    { merkleRoot }
  );
  return rows.map((r) => ({
    address: r.address,
    proofs: parseStoredMerkleProofs(r.proofs)
  }));
}

export interface MintingMerkleRootRow {
  phase: string;
  merkle_root: string;
  addresses_count?: number;
  total_spots?: number;
}

export interface MintingAirdropPhaseRow {
  phase: string;
  addresses_count?: number;
  total_airdrops?: number;
}

export async function fetchMintingMerkleRoots(
  cardId: number,
  contract: string
): Promise<MintingMerkleRootRow[]> {
  const roots = await sqlExecutor.execute<MintingMerkleRootRow>(
    `SELECT phase, merkle_root FROM ${MINTING_MERKLE_ROOTS_TABLE} WHERE card_id = :cardId AND contract = :contract ORDER BY phase ASC`,
    { cardId, contract: contract.toLowerCase() }
  );
  if (roots.length === 0) {
    return roots;
  }

  const merkleRoots = roots.map((r) => r.merkle_root).filter(Boolean);
  if (merkleRoots.length === 0) {
    return roots.map((root) => ({
      ...root,
      addresses_count: 0,
      total_spots: 0
    }));
  }

  const proofRows = await sqlExecutor.execute<{
    merkle_root: string;
    proofs: StoredMerkleProofs;
  }>(
    `SELECT merkle_root, proofs FROM ${MINTING_MERKLE_PROOFS_TABLE} WHERE merkle_root IN (:merkleRoots)`,
    { merkleRoots }
  );

  const countsByRoot = new Map<
    string,
    { addresses_count: number; total_spots: number }
  >();

  for (const row of proofRows) {
    const root = row.merkle_root;
    const current = countsByRoot.get(root) ?? {
      addresses_count: 0,
      total_spots: 0
    };
    const parsed = parseStoredMerkleProofs(row.proofs);
    const rowSpots = parsed.length;
    countsByRoot.set(root, {
      addresses_count: current.addresses_count + 1,
      total_spots: current.total_spots + rowSpots
    });
  }

  return roots.map((root) => {
    const counts = countsByRoot.get(root.merkle_root);
    return {
      ...root,
      addresses_count: counts?.addresses_count ?? 0,
      total_spots: counts?.total_spots ?? 0
    };
  });
}

export async function fetchMintingAirdrops(
  cardId: number,
  contract: string
): Promise<MintingAirdropPhaseRow[]> {
  return sqlExecutor.execute<MintingAirdropPhaseRow>(
    `SELECT phase, COUNT(DISTINCT wallet) AS addresses_count, COALESCE(SUM(count_airdrop), 0) AS total_airdrops
     FROM ${DISTRIBUTION_TABLE}
     WHERE card_id = :cardId
       AND contract = :contract
       AND count_airdrop > 0
       AND phase IN (:automaticAirdropPhases)
     GROUP BY phase
     ORDER BY phase ASC`,
    {
      cardId,
      contract: contract.toLowerCase(),
      automaticAirdropPhases: [...DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES]
    }
  );
}

export interface MemeClaimRow {
  drop_id: string;
  meme_id: number;
  season: number;
  image_location: string | null;
  animation_location: string | null;
  metadata_location: string | null;
  media_uploading: boolean | number;
  edition_size: number | null;
  description: string;
  name: string;
  image_url: string | null;
  attributes: string;
  image_details: string | null;
  animation_url: string | null;
  animation_details: string | null;
}

export async function fetchMemeClaimByDropId(
  dropId: string
): Promise<MemeClaimRow | null> {
  const rows = await sqlExecutor.execute<MemeClaimRow>(
    `SELECT drop_id, meme_id, season, image_location, animation_location, metadata_location, media_uploading, edition_size, description, name, image_url, attributes, image_details, animation_url, animation_details FROM ${MEMES_CLAIMS_TABLE} WHERE drop_id = :dropId LIMIT 1`,
    { dropId }
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function fetchMemeClaimByMemeId(
  memeId: number
): Promise<MemeClaimRow | null> {
  const rows = await sqlExecutor.execute<MemeClaimRow>(
    `SELECT drop_id, meme_id, season, image_location, animation_location, metadata_location, media_uploading, edition_size, description, name, image_url, attributes, image_details, animation_url, animation_details FROM ${MEMES_CLAIMS_TABLE} WHERE meme_id = :memeId LIMIT 1`,
    { memeId }
  );
  return rows.length > 0 ? rows[0] : null;
}

const MEMES_CLAIMS_SELECT = `SELECT drop_id, meme_id, season, image_location, animation_location, metadata_location, media_uploading, edition_size, description, name, image_url, attributes, image_details, animation_url, animation_details FROM ${MEMES_CLAIMS_TABLE}`;

export async function fetchMemeClaimsTotalCount(): Promise<number> {
  const rows = await sqlExecutor.execute<{ total: number }>(
    `SELECT COUNT(*) as total FROM ${MEMES_CLAIMS_TABLE}`
  );
  return rows[0]?.total ?? 0;
}

export async function fetchMemeClaimsPage(
  limit: number,
  offset: number
): Promise<MemeClaimRow[]> {
  return sqlExecutor.execute<MemeClaimRow>(
    `${MEMES_CLAIMS_SELECT} ORDER BY meme_id DESC LIMIT :limit OFFSET :offset`,
    { limit, offset }
  );
}

export async function fetchMaxSeasonId(): Promise<number> {
  const rows = await sqlExecutor.execute<{ max_id: number }>(
    `SELECT COALESCE(MAX(id), 0) as max_id FROM ${MEMES_SEASONS_TABLE}`
  );
  return rows[0]?.max_id ?? 0;
}

export async function fetchMemeIdByMemeName(
  memeName: string
): Promise<number | null> {
  const rows = await sqlExecutor.execute<{ meme: number }>(
    `SELECT meme FROM ${MEMES_EXTENDED_DATA_TABLE} WHERE meme_name = :memeName LIMIT 1`,
    { memeName }
  );
  return rows.length > 0 ? rows[0].meme : null;
}

export async function updateMemeClaim(
  memeId: number,
  updates: {
    season?: number;
    image_location?: string | null;
    animation_location?: string | null;
    metadata_location?: string | null;
    media_uploading?: boolean;
    edition_size?: number | null;
    description?: string;
    name?: string;
    image_url?: string | null;
    attributes?: unknown;
    image_details?: unknown;
    animation_url?: string | null;
    animation_details?: unknown;
  }
): Promise<void> {
  const { setClauses, params } = buildMemeClaimUpdateStatement(memeId, updates);
  if (setClauses.length === 0) return;
  await sqlExecutor.execute(
    `UPDATE ${MEMES_CLAIMS_TABLE} SET ${setClauses.join(', ')} WHERE meme_id = :memeId`,
    params
  );
}

function buildMemeClaimUpdateStatement(
  memeId: number,
  updates: {
    season?: number;
    image_location?: string | null;
    animation_location?: string | null;
    metadata_location?: string | null;
    media_uploading?: boolean;
    edition_size?: number | null;
    description?: string;
    name?: string;
    image_url?: string | null;
    attributes?: unknown;
    image_details?: unknown;
    animation_url?: string | null;
    animation_details?: unknown;
  }
): { setClauses: string[]; params: Record<string, unknown> } {
  const keys = Object.keys(updates) as (keyof typeof updates)[];
  if (keys.length === 0) return { setClauses: [], params: { memeId } };
  const setClauses: string[] = [];
  const params: Record<string, unknown> = { memeId };
  for (const key of keys) {
    const val = updates[key];
    if (val === undefined) continue;
    const col = key;
    setClauses.push(`${col} = :${col}`);
    let paramVal: unknown;
    if (
      col === 'attributes' ||
      col === 'image_details' ||
      col === 'animation_details'
    ) {
      paramVal = JSON.stringify(val);
    } else {
      paramVal = val;
    }
    params[col] = paramVal;
  }
  return { setClauses, params };
}

function getAffectedRowsFromUpdateResult(result: unknown): number {
  if (
    result != null &&
    typeof result === 'object' &&
    'affectedRows' in result
  ) {
    return Number((result as { affectedRows?: unknown }).affectedRows);
  }
  if (!Array.isArray(result)) {
    return 0;
  }
  const first = result[0] as unknown;
  const second = result[1] as unknown;
  if (first != null && typeof first === 'object' && 'affectedRows' in first) {
    return Number((first as { affectedRows?: unknown }).affectedRows);
  }
  return Number(second ?? 0);
}

export async function updateMemeClaimIfNotUploading(
  memeId: number,
  updates: {
    season?: number;
    image_location?: string | null;
    animation_location?: string | null;
    metadata_location?: string | null;
    media_uploading?: boolean;
    edition_size?: number | null;
    description?: string;
    name?: string;
    image_url?: string | null;
    attributes?: unknown;
    image_details?: unknown;
    animation_url?: string | null;
    animation_details?: unknown;
  }
): Promise<boolean> {
  const { setClauses, params } = buildMemeClaimUpdateStatement(memeId, updates);
  if (setClauses.length === 0) return true;
  const result = await sqlExecutor.execute<{ affectedRows: number }>(
    `UPDATE ${MEMES_CLAIMS_TABLE}
     SET ${setClauses.join(', ')}
     WHERE meme_id = :memeId
       AND COALESCE(media_uploading, 0) = 0
       AND metadata_location IS NULL`,
    params
  );
  const affectedRows = getAffectedRowsFromUpdateResult(result);
  return affectedRows > 0;
}
