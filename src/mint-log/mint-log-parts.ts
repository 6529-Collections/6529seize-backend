import {
  DISTRIBUTION_NORMALIZED_TABLE,
  DISTRIBUTION_PHOTO_TABLE,
  DISTRIBUTION_TABLE,
  MEME_CARD_DROP_MAPPINGS_TABLE,
  MEMES_CONTRACT,
  MINTING_CLAIM_ACTIONS_TABLE,
  MINTING_CLAIMS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import {
  MEME_COLLABORATION_INVITATIONS_TABLE,
  MEME_COLLABORATIONS_TABLE,
  REMEMES_TABLE,
  REMEMES_UPLOADS,
  ROYALTIES_UPLOADS_TABLE
} from '@/constants';
import {
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_BURN_COLLECTIONS_TABLE
} from '@/nextgen/nextgen_constants';
import {
  COLLAB_CARD_CONTRACT,
  MintCardRef,
  MintRow,
  MintRowPart,
  NEXTGEN_CARD_CONTRACT,
  REMEMES_CARD_CONTRACT,
  UPLOADS_CARD_CONTRACT
} from './mint-log.types';

/**
 * How one card's slice of a table is read, compared and written back.
 *
 * `excluded` columns are not part of the log: they are ephemeral (claim upload
 * leases) or derived again on rebuild from another source (minted counts from
 * Ethereum transfers, card name and mint date from the NFT index). A write
 * never touches them on an existing row; a new row gets `insertDefaults`.
 */
export interface MintRowPartSpec {
  readonly part: MintRowPart;
  readonly table: string;
  /** SQL condition on :contract and :card_id. */
  readonly scope: string;
  readonly key: readonly string[];
  readonly excluded: readonly string[];
  /** When set, only these columns are logged. */
  readonly only?: readonly string[];
  /**
   * 'upsert': rows are inserted or replaced and deleted.
   * 'update-only': another module owns the table; the log only sets the
   * listed columns on rows that module creates, and never deletes.
   */
  readonly mode: 'upsert' | 'update-only';
  readonly insertDefaults?: (
    row: MintRow
  ) => Record<string, string | number | null>;
  /** False when this part does not exist for the card's contract. */
  readonly appliesTo?: (card: MintCardRef) => boolean;
}

const CARD_SCOPE = 'contract = :contract and card_id = :card_id';
const CLAIM_SCOPE = 'contract = :contract and claim_id = :card_id';
const COLLECTION_SCOPE = 'collection_id = :card_id';

const SCOPES = new Set([
  NEXTGEN_CARD_CONTRACT,
  REMEMES_CARD_CONTRACT,
  COLLAB_CARD_CONTRACT,
  UPLOADS_CARD_CONTRACT
]);
const isScope = (name: string) => (card: MintCardRef) => card.contract === name;
const isNextgen = isScope(NEXTGEN_CARD_CONTRACT);
const isToken = (card: MintCardRef) => !SCOPES.has(card.contract);

/**
 * S3 copies of a rememe image: the S3 loop makes them again from the
 * image, so they are not logged.
 */
const REMEME_S3_COLUMNS = [
  's3_image_original',
  's3_image_scaled',
  's3_image_thumbnail',
  's3_image_icon',
  's3_image_processing_status',
  's3_image_processing_error',
  's3_image_last_attempt_at',
  's3_image_processing_attempts'
];

export const MINT_ROW_PART_SPECS: Readonly<
  Record<MintRowPart, MintRowPartSpec>
> = {
  distribution: {
    part: 'distribution',
    appliesTo: isToken,
    table: DISTRIBUTION_TABLE,
    scope: CARD_SCOPE,
    key: ['id'],
    excluded: [],
    mode: 'upsert'
  },
  normalized: {
    part: 'normalized',
    appliesTo: isToken,
    table: DISTRIBUTION_NORMALIZED_TABLE,
    scope: CARD_SCOPE,
    key: ['card_id', 'contract', 'wallet'],
    // minted and total_count follow from mint transfers after the normalize
    // entry; card_name and mint_date come from the NFT index.
    excluded: ['minted', 'total_count', 'card_name', 'mint_date'],
    mode: 'upsert',
    insertDefaults: (row) => ({
      minted: 0,
      total_count: typeof row.airdrops === 'number' ? row.airdrops : 0,
      card_name: null,
      mint_date: null
    })
  },
  photos: {
    part: 'photos',
    appliesTo: isToken,
    table: DISTRIBUTION_PHOTO_TABLE,
    scope: CARD_SCOPE,
    key: ['id'],
    excluded: [],
    mode: 'upsert'
  },
  claim: {
    part: 'claim',
    appliesTo: isToken,
    table: MINTING_CLAIMS_TABLE,
    scope: CLAIM_SCOPE,
    key: ['drop_id'],
    // The upload lease is a lock; a rebuild starts with none held.
    excluded: [
      'media_uploading',
      'media_upload_lease_token',
      'media_upload_lease_until'
    ],
    mode: 'upsert'
  },
  claim_actions: {
    part: 'claim_actions',
    appliesTo: isToken,
    table: MINTING_CLAIM_ACTIONS_TABLE,
    scope: CLAIM_SCOPE,
    key: ['id'],
    excluded: [],
    mode: 'upsert'
  },
  card_mapping: {
    part: 'card_mapping',
    table: MEME_CARD_DROP_MAPPINGS_TABLE,
    scope: 'meme_card_id = :card_id',
    key: ['meme_card_id'],
    excluded: [],
    mode: 'upsert',
    appliesTo: (card) => card.contract === MEMES_CONTRACT.toLowerCase()
  },
  subscription_phases: {
    part: 'subscription_phases',
    appliesTo: isToken,
    table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
    scope: 'contract = :contract and token_id = :card_id',
    key: ['consolidation_key'],
    excluded: [],
    only: [
      'consolidation_key',
      'phase',
      'phase_subscriptions',
      'phase_position'
    ],
    mode: 'update-only'
  },
  nextgen_allowlists: {
    part: 'nextgen_allowlists',
    appliesTo: isNextgen,
    table: NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
    scope: COLLECTION_SCOPE,
    key: ['merkle_root', 'collection_id'],
    excluded: [],
    mode: 'upsert'
  },
  nextgen_allowlist_rows: {
    part: 'nextgen_allowlist_rows',
    appliesTo: isNextgen,
    table: NEXTGEN_ALLOWLIST_TABLE,
    scope: COLLECTION_SCOPE,
    key: ['collection_id', 'merkle_root', 'address', 'info'],
    excluded: [],
    mode: 'upsert'
  },
  nextgen_allowlist_burn_rows: {
    part: 'nextgen_allowlist_burn_rows',
    appliesTo: isNextgen,
    table: NEXTGEN_ALLOWLIST_BURN_TABLE,
    scope: COLLECTION_SCOPE,
    key: ['collection_id', 'merkle_root', 'token_id', 'info'],
    excluded: [],
    mode: 'upsert'
  },
  nextgen_burn_collection: {
    part: 'nextgen_burn_collection',
    appliesTo: isNextgen,
    table: NEXTGEN_BURN_COLLECTIONS_TABLE,
    scope: COLLECTION_SCOPE,
    key: ['collection_id'],
    excluded: [],
    mode: 'upsert'
  },
  // A rememe contract's rows; the card key is the contract.
  rememes: {
    part: 'rememes',
    appliesTo: isScope(REMEMES_CARD_CONTRACT),
    table: REMEMES_TABLE,
    scope: 'contract = :key',
    key: ['contract', 'id'],
    // updated_at moves with every provider refresh, which is not logged.
    excluded: [...REMEME_S3_COLUMNS, 'updated_at'],
    mode: 'upsert'
  },
  // One artwork's collaboration; the card key is the drop id.
  collaboration: {
    part: 'collaboration',
    appliesTo: isScope(COLLAB_CARD_CONTRACT),
    table: MEME_COLLABORATIONS_TABLE,
    scope: 'drop_id = :key',
    key: ['drop_id'],
    excluded: [],
    mode: 'upsert'
  },
  collaboration_invitations: {
    part: 'collaboration_invitations',
    appliesTo: isScope(COLLAB_CARD_CONTRACT),
    table: MEME_COLLABORATION_INVITATIONS_TABLE,
    scope: 'drop_id = :key',
    key: ['id'],
    excluded: [],
    mode: 'upsert'
  },
  // Published files, one row per upload; the card key names the table.
  rememe_uploads: {
    part: 'rememe_uploads',
    appliesTo: (card) =>
      card.contract === UPLOADS_CARD_CONTRACT && card.key === REMEMES_UPLOADS,
    table: REMEMES_UPLOADS,
    scope: '1 = 1',
    key: ['url'],
    excluded: [],
    mode: 'upsert'
  },
  royalties_uploads: {
    part: 'royalties_uploads',
    appliesTo: (card) =>
      card.contract === UPLOADS_CARD_CONTRACT &&
      card.key === ROYALTIES_UPLOADS_TABLE,
    table: ROYALTIES_UPLOADS_TABLE,
    scope: '1 = 1',
    key: ['date'],
    excluded: [],
    mode: 'upsert'
  }
};

export function mintCard(
  contract: string,
  cardId: number,
  key?: string
): MintCardRef {
  return key === undefined
    ? { contract: contract.toLowerCase(), card_id: cardId }
    : { contract: contract.toLowerCase(), card_id: cardId, key };
}

/** The named parameters a part's scope may use. */
export function cardParams(card: MintCardRef): Record<string, string | number> {
  return {
    contract: card.contract,
    card_id: card.card_id,
    key: card.key ?? ''
  };
}

export function partApplies(spec: MintRowPartSpec, card: MintCardRef): boolean {
  return spec.appliesTo ? spec.appliesTo(card) : true;
}

export function rowKey(spec: MintRowPartSpec, row: MintRow): string {
  return JSON.stringify(spec.key.map((column) => row[column] ?? null));
}

export function keyOnly(spec: MintRowPartSpec, row: MintRow): MintRow {
  const key: Record<string, string | number | null> = {};
  for (const column of spec.key) {
    key[column] = row[column] ?? null;
  }
  return key;
}

export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Sorts rows by their key, so two captures of the same rows compare equal. */
export function sortRows(spec: MintRowPartSpec, rows: MintRow[]): MintRow[] {
  return [...rows].sort((a, b) =>
    compareText(rowKey(spec, a), rowKey(spec, b))
  );
}
