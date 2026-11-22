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
import type { MintCardRef, MintRow, MintRowPart } from './mint-log.types';

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

export const MINT_ROW_PART_SPECS: Readonly<
  Record<MintRowPart, MintRowPartSpec>
> = {
  distribution: {
    part: 'distribution',
    table: DISTRIBUTION_TABLE,
    scope: CARD_SCOPE,
    key: ['id'],
    excluded: [],
    mode: 'upsert'
  },
  normalized: {
    part: 'normalized',
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
    table: DISTRIBUTION_PHOTO_TABLE,
    scope: CARD_SCOPE,
    key: ['id'],
    excluded: [],
    mode: 'upsert'
  },
  claim: {
    part: 'claim',
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
  }
};

export function mintCard(contract: string, cardId: number): MintCardRef {
  return { contract: contract.toLowerCase(), card_id: cardId };
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
