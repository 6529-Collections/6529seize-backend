import {
  ChainFeedBlock,
  ChainFeedRecord,
  ChainFeedWriter,
  ChainRatingTotal
} from '@/chain-gateway/chain-gateway.types';
import { HEX32 } from './wallet-bindings';

/** The feed's Rating records: `Rating[rater, matter, targetKind, target, category]`. */
export const RATING_FAMILY = '0x0701';
/** The feed's RatingTotal records: a target's sum in a matter and category. */
export const RATING_TOTAL_FAMILY = '0x0704';
/** The feed's Category records: `Category[categoryId]`, with its name. */
export const CATEGORY_FAMILY = '0x0705';
/** The families the rating events follower reads. */
export const RATING_EVENT_FAMILIES = [
  RATING_FAMILY,
  RATING_TOTAL_FAMILY,
  CATEGORY_FAMILY
];
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
  /** The record's own key fields: the matter (1, 2) and target kind. */
  readonly matterCode: number;
  readonly targetKind: number;
  /** The record's category field (zero for NIC). */
  readonly category: string;
  /** The REP category's id; null for NIC. */
  readonly categoryId: string | null;
  /** The record's state key (to read the rating at another height). */
  readonly stateKey: string;
  /**
   * The value set; 0 when the rating was removed; null when the record's
   * value can't be read (its key can: the ledger marks it stale).
   */
  readonly value: number | null;
  readonly writer: ChainFeedWriter | null;
  /** The record's import marker as given (null: not known). */
  readonly byImport: boolean | null;
}

/** The ledger's key of a rating: the record's own key fields. */
export function ledgerKeyOf(it: {
  readonly rater: string;
  readonly matterCode: number;
  readonly targetKind: number;
  readonly target: string;
  readonly category: string;
}): string {
  return JSON.stringify([
    it.rater,
    it.matterCode,
    it.targetKind,
    it.target,
    it.category
  ]);
}

/** The key of a target's total in a matter and category. */
export function totalKeyOf(it: {
  readonly targetKind: number;
  readonly target: string;
  readonly matterCode: number;
  readonly category: string;
}): string {
  return JSON.stringify([it.targetKind, it.target, it.matterCode, it.category]);
}

function hex32(value: unknown): string | null {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  return HEX32.test(text) ? text : null;
}

/** A Rating record that is an identity's REP or NIC rating, else why not. */
function toRatingChange(
  block: ChainFeedBlock,
  record: ChainFeedRecord
): ChainRatingChange | 'other' | 'unreadable' {
  const fields = record.keyFields ?? {};
  const targetKind = Number(fields.targetKind ?? IDENTITY_TARGET);
  if (targetKind !== IDENTITY_TARGET) return 'other';
  const rater = hex32(fields.rater);
  const target = hex32(fields.target);
  const matter = MATTERS[String(fields.matter ?? '').toLowerCase()];
  const category = hex32(fields.category);
  if (!rater || !target || !matter || !category) return 'unreadable';
  if (matter === 'REP' && category === ZERO32) return 'unreadable';
  // A removal has no value; a value without its fields can't be read (it
  // is never taken for a removal).
  let value: number | null = 0;
  if (record.value !== null) {
    value = Number(record.valueFields?.value);
    if (record.valueFields == null || !Number.isSafeInteger(value)) {
      value = null;
    }
  }
  return {
    height: Number(block.height),
    blockTimeMs: Number(block.time),
    rater,
    target,
    matter,
    matterCode: matter === 'REP' ? 1 : 2,
    targetKind,
    category,
    categoryId: matter === 'REP' ? category : null,
    stateKey: record.key,
    value,
    writer: record.writer ?? null,
    byImport: record.byImport ?? null
  };
}

/**
 * The Rating records of feed blocks, in block and record order (the feed
 * gives each key's final value in a block once), the REP category names
 * the blocks' Category records give, and each block's RatingTotal sums
 * (by height, then totalKeyOf). Records of other target kinds are left
 * out; ones that can't be read are named (`height:key`), and a record
 * whose key can be read but not its value is a change with value null.
 */
export function ratingChangesOf(blocks: readonly ChainFeedBlock[]): {
  changes: ChainRatingChange[];
  categoryNames: Map<string, string>;
  totals: Map<number, Map<string, number>>;
  unreadable: string[];
} {
  const changes: ChainRatingChange[] = [];
  const categoryNames = new Map<string, string>();
  const totals = new Map<number, Map<string, number>>();
  const unreadable: string[] = [];
  for (const block of blocks) {
    const height = Number(block.height);
    for (const record of block.records) {
      const family = record.family.toLowerCase();
      if (family === CATEGORY_FAMILY) {
        const id = hex32(record.keyFields?.categoryId);
        const name = record.valueFields?.name;
        if (id && typeof name === 'string') categoryNames.set(id, name);
        continue;
      }
      if (family === RATING_TOTAL_FAMILY) {
        const fields = record.keyFields ?? {};
        const target = hex32(fields.target);
        const category = hex32(fields.category);
        const matter = MATTERS[String(fields.matter ?? '').toLowerCase()];
        const sum = record.value === null ? 0 : Number(record.valueFields?.sum);
        if (target && category && matter && Number.isSafeInteger(sum)) {
          const ofBlock = totals.get(height) ?? new Map<string, number>();
          ofBlock.set(
            totalKeyOf({
              targetKind: Number(fields.targetKind ?? IDENTITY_TARGET),
              target,
              matterCode: matter === 'REP' ? 1 : 2,
              category
            }),
            sum
          );
          totals.set(height, ofBlock);
        }
        continue;
      }
      if (family !== RATING_FAMILY) continue;
      const change = toRatingChange(block, record);
      if (change === 'other') continue;
      if (change === 'unreadable' || change.value === null) {
        unreadable.push(`${height}:${record.key}`);
      }
      if (change !== 'unreadable') changes.push(change);
    }
  }
  return { changes, categoryNames, totals, unreadable };
}

/**
 * The change's matter and category total in a target's totals as the
 * gateway gives them (0 when none is listed: no rater left); null when the
 * total isn't a whole number it can hold.
 */
export function totalIn(
  totals: readonly ChainRatingTotal[],
  change: Pick<ChainRatingChange, 'matter' | 'category'>
): number | null {
  const found = totals.find((it) => {
    if (MATTERS[String(it.matter ?? '').toLowerCase()] !== change.matter) {
      return false;
    }
    const id = hex32(it.category?.id);
    return change.matter === 'REP'
      ? id === change.category
      : id === null || id === ZERO32;
  });
  if (!found) return 0;
  const total = Number(found.total);
  return Number.isSafeInteger(total) ? total : null;
}

/** The state key of a REP category's Category record. */
export function categoryKey(categoryId: string): string {
  return `${CATEGORY_FAMILY}${categoryId.toLowerCase().replace(/^0x/, '')}`;
}
