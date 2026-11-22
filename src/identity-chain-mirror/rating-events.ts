import {
  ChainFeedBlock,
  ChainFeedRecord,
  ChainFeedWriter
} from '@/chain-gateway/chain-gateway.types';
import { HEX32 } from './wallet-bindings';

/** The feed's Rating records: `Rating[rater, matter, targetKind, target, category]`. */
export const RATING_FAMILY = '0x0701';
/** The feed's Category records: `Category[categoryId]`, with its name. */
export const CATEGORY_FAMILY = '0x0705';
/** RATING_SET's opType: the operation a rater sets a rating with. */
export const RATING_SET_OP = 0x0701;
/** The chain's matters: REP 1, NIC 2 (6529.io's CIC). */
const MATTERS: Record<string, 'REP' | 'CIC'> = {
  '1': 'REP',
  '2': 'CIC',
  rep: 'REP',
  nic: 'CIC',
  cic: 'CIC'
};
/** A rating of an identity (the other target kinds aren't 6529.io's). */
const IDENTITY_TARGET = 1;
const ZERO32 = '0x' + '00'.repeat(32);

export type RatingEventOrigin = 'OPERATION' | 'CAP_CUT' | 'IMPORT' | 'UNKNOWN';

/**
 * Why a rating record changed, from the record's last writer in its block
 * (GATEWAY-API.md, I17) and the import's marker:
 * - OPERATION: a RATING_SET transaction;
 * - CAP_CUT: the daily rating reduction (system step RATING_SCAN);
 * - IMPORT: the identity import (system step IMPORT), or no writer known
 *   on a record the import wrote (`byImport`);
 * - UNKNOWN: anything else (another transaction, other system work, or no
 *   writer on a record not the import's).
 * Only OPERATION is news for the notifications.
 */
export function ratingEventOrigin(
  writer: ChainFeedWriter | null | undefined,
  byImport: boolean | null | undefined
): RatingEventOrigin {
  if (!writer) return byImport === true ? 'IMPORT' : 'UNKNOWN';
  if (writer.kind === 'tx') {
    const isRatingSet =
      writer.opName === 'RATING_SET' || Number(writer.opType) === RATING_SET_OP;
    return isRatingSet ? 'OPERATION' : 'UNKNOWN';
  }
  if (writer.kind === 'system') {
    if (writer.step === 'RATING_SCAN') return 'CAP_CUT';
    if (writer.step === 'IMPORT') return 'IMPORT';
  }
  return 'UNKNOWN';
}

/**
 * The writer as the event row keeps it (40 characters at most): the
 * transaction's operation (`tx:RATING_SET`) or the system step
 * (`system:RATING_SCAN`); null when the feed gives none.
 */
export function writerText(
  writer: ChainFeedWriter | null | undefined
): string | null {
  if (!writer) return null;
  const what =
    writer.kind === 'tx'
      ? (writer.opName ?? String(writer.opType))
      : writer.kind === 'system'
        ? writer.step
        : '';
  return `${writer.kind}:${what}`.slice(0, 40);
}

/** One Rating record of a block, as the event log reads it. */
export interface ChainRatingChange {
  readonly height: number;
  /** The block's slot start, Unix ms (the feed's `time`). */
  readonly blockTimeMs: number;
  readonly rater: string;
  readonly target: string;
  readonly matter: 'REP' | 'CIC';
  /** The REP category's id; null for NIC. */
  readonly categoryId: string | null;
  /** The value set; 0 when the rating was removed. */
  readonly value: number;
  readonly writer: ChainFeedWriter | null;
  readonly byImport: boolean;
}

function hex32(value: unknown): string | null {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  return HEX32.test(text) ? text : null;
}

function toRatingChange(
  block: ChainFeedBlock,
  record: ChainFeedRecord
): ChainRatingChange | null {
  const fields = record.keyFields ?? {};
  const rater = hex32(fields.rater);
  const target = hex32(fields.target);
  const matter = MATTERS[String(fields.matter ?? '').toLowerCase()];
  const targetKind = Number(fields.targetKind ?? IDENTITY_TARGET);
  if (!rater || !target || !matter || targetKind !== IDENTITY_TARGET) {
    return null;
  }
  const category = hex32(fields.category);
  if (matter === 'REP' && (!category || category === ZERO32)) return null;
  const raw =
    record.value === null || record.valueFields == null
      ? 0
      : Number(record.valueFields.value);
  if (!Number.isSafeInteger(raw)) return null;
  return {
    height: Number(block.height),
    blockTimeMs: Number(block.time),
    rater,
    target,
    matter,
    categoryId: matter === 'REP' ? category : null,
    value: raw,
    writer: record.writer ?? null,
    byImport: record.byImport === true
  };
}

/**
 * The Rating records of feed blocks, in block and record order (the feed
 * gives each key's final value in a block once), and the REP category names
 * the blocks' Category records give. Records that aren't an identity's
 * REP or NIC rating, or can't be read, are left out.
 */
export function ratingChangesOf(blocks: readonly ChainFeedBlock[]): {
  changes: ChainRatingChange[];
  categoryNames: Map<string, string>;
  unreadable: number;
} {
  const changes: ChainRatingChange[] = [];
  const categoryNames = new Map<string, string>();
  let unreadable = 0;
  for (const block of blocks) {
    for (const record of block.records) {
      const family = record.family.toLowerCase();
      if (family === CATEGORY_FAMILY) {
        const id = hex32(record.keyFields?.categoryId);
        const name = record.valueFields?.name;
        if (id && typeof name === 'string') categoryNames.set(id, name);
        continue;
      }
      if (family !== RATING_FAMILY) continue;
      const change = toRatingChange(block, record);
      if (change) changes.push(change);
      else unreadable++;
    }
  }
  return { changes, categoryNames, unreadable };
}

/** The state key of a REP category's Category record. */
export function categoryKey(categoryId: string): string {
  return `${CATEGORY_FAMILY}${categoryId.toLowerCase().replace(/^0x/, '')}`;
}
