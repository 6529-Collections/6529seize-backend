import { createHash } from 'node:crypto';

/*
 * The opening file: the legacy subscription tables at the identity switch,
 * keyed by identity. It is cut in one read transaction, hashed, published,
 * loaded into the empty identity tables and compared with the legacy tables
 * (opening-compare.ts) before the identity tables become the truth. Its companion, the
 * history file, carries the log lines and the choices for cards already
 * dropped; the opening file names it by hash.
 *
 * Both files are canonical JSON (object keys sorted, arrays in the builder's
 * order, numbers as JavaScript prints doubles), so the same tables give the
 * same bytes and the same hash. Dates are the database's own text,
 * 'YYYY-MM-DD HH:MM:SS.ffffff' in UTC, so they load back unchanged.
 */

export const OPENING_FORMAT = '6529-subscriptions-opening/1';
export const HISTORY_FORMAT = '6529-subscriptions-history/1';

export interface OpeningCut {
  /** When the read transaction started, ISO. */
  readonly at: string;
  /** The newest Meme at the cut; choices for later cards are open. */
  readonly maxMemeId: number;
  /** The top-up loop's last block, or null if it never ran. */
  readonly topUpBlock: number | null;
  /** The redemption loop's last block, or null if it never ran. */
  readonly redemptionBlock: number | null;
  readonly mintPrice: number;
}

export interface OpeningKey {
  readonly consolidationKey: string;
  /** Where the key's current state went (balance, mode, open choices). */
  readonly identityKey: string;
  /** Every identity the key's wallets belong to, sorted. */
  readonly identities: readonly string[];
}

export type BlockedReason =
  /**
   * The key's wallets belong to more than one identity: a split, which the
   * legacy re-key (consolidateSubscriptions) must make before the cut.
   */
  | 'SPANS_IDENTITIES'
  /**
   * A redemption is still queued for the key (the key-width guard): it must
   * be replayed before the cut, so the charge is not lost.
   */
  | 'PENDING_REDEMPTION';

/** Something that stops the cut from being loaded; the load refuses it. */
export interface BlockedKey {
  readonly consolidationKey: string;
  readonly reason: BlockedReason;
  readonly identities: readonly string[];
}

/**
 * Keys with current state that now belong to one identity, merged at the
 * cut by the legacy merge rules (consolidateSubscriptions): balances summed,
 * automatic and all-editions kept if any key had them, choices for the same
 * card combined as mergeUpcomingSubscriptions does. This is what the legacy
 * re-key would have done; the key-width guard held it back.
 */
export interface MergedIdentity {
  readonly identityKey: string;
  /** In the order they were folded in; the first survives. */
  readonly consolidationKeys: readonly string[];
}

export type QueuedEffect =
  /** A waiting top-up credited to the sender's identity at the cut. */
  | 'TOP_UP_CREDITED'
  /** A waiting top-up whose hash was already credited. */
  | 'TOP_UP_ALREADY_CREDITED'
  /** A waiting log line carried into the history. */
  | 'LOG_CARRIED'
  /** A list row the next daily build recomputes. */
  | 'LEFT_TO_THE_BUILD'
  /** A re-key, made at the cut by merging the identity's keys. */
  | 'MERGED_AT_CUT'
  /** A redemption: the cut is blocked until it is replayed. */
  | 'BLOCKS_THE_CUT';

/** What the cut did with each write the key-width guard held back. */
export interface QueuedNote {
  readonly sequence: number;
  readonly kind: string;
  readonly consolidationKey: string;
  readonly identityKey: string;
  readonly effect: QueuedEffect;
}

export interface OpeningBalance {
  readonly identityKey: string;
  readonly balance: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpeningMode {
  readonly identityKey: string;
  readonly automatic: boolean;
  readonly subscribeAllEditions: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpeningChoice {
  readonly identityKey: string;
  readonly contract: string;
  readonly tokenId: number;
  readonly subscribed: boolean;
  readonly subscribedCount: number;
  readonly automaticSubscription: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpeningTopUp {
  readonly hash: string;
  readonly block: number;
  readonly transactionDate: string;
  readonly fromWallet: string;
  readonly amount: number;
  readonly identityKey: string;
  readonly createdAt: string;
}

export interface OpeningFinalRow {
  /**
   * The legacy row id, kept in the identity table: the mint log records
   * phase changes by final row id.
   */
  readonly id: number;
  readonly identityKey: string;
  readonly consolidationKey: string;
  readonly contract: string;
  readonly tokenId: number;
  readonly subscribedCount: number;
  readonly airdropAddress: string;
  readonly balance: number;
  readonly subscribedAt: string | null;
  readonly phase: string | null;
  readonly phaseSubscriptions: number;
  readonly phasePosition: number;
  readonly redeemedCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpeningUpload {
  readonly contract: string;
  readonly tokenId: number;
  readonly date: string;
  readonly uploadUrl: string;
  readonly createdAt: string;
}

export interface OpeningRedeemed {
  readonly identityKey: string;
  readonly consolidationKey: string;
  readonly contract: string;
  readonly tokenId: number;
  readonly address: string;
  readonly transaction: string;
  readonly transactionDate: string | null;
  readonly value: number;
  readonly balanceAfter: number;
  readonly count: number;
  readonly createdAt: string;
}

/** How a history row's identity was chosen when its key spans several. */
export interface AttributionNote {
  readonly table: string;
  readonly consolidationKey: string;
  readonly identityKey: string;
  readonly rule: 'AIRDROP_ADDRESS' | 'FIRST_IDENTITY';
}

export interface OpeningTotals {
  readonly keys: number;
  readonly identities: number;
  readonly balances: number;
  readonly modes: number;
  readonly choices: number;
  readonly topUps: number;
  readonly finalRows: number;
  readonly uploads: number;
  readonly redeemedRows: number;
  /** Exact decimal sums of the doubles, for the conservation check. */
  readonly balanceSum: string;
  readonly topUpSum: string;
  readonly redeemedCount: number;
  readonly redeemedValueSum: string;
}

export interface OpeningFile {
  readonly format: typeof OPENING_FORMAT;
  readonly cut: OpeningCut;
  readonly historySha256: string;
  readonly keys: readonly OpeningKey[];
  readonly blocked: readonly BlockedKey[];
  readonly merged: readonly MergedIdentity[];
  readonly queued: readonly QueuedNote[];
  readonly attribution: readonly AttributionNote[];
  readonly balances: readonly OpeningBalance[];
  readonly modes: readonly OpeningMode[];
  readonly choices: readonly OpeningChoice[];
  readonly topUps: readonly OpeningTopUp[];
  readonly finalRows: readonly OpeningFinalRow[];
  readonly uploads: readonly OpeningUpload[];
  readonly redeemed: readonly OpeningRedeemed[];
  readonly totals: OpeningTotals;
}

export interface HistoryLog {
  /** The legacy row's id; null for a line that was waiting in the queue. */
  readonly legacyId: number | null;
  /** The queue entry's sequence for a line that was waiting; else null. */
  readonly queueSequence: number | null;
  readonly identityKey: string;
  readonly consolidationKey: string;
  readonly log: string;
  readonly additionalInfo: string | null;
  readonly createdAt: string;
}

/** A choice for a card already dropped: kept, not loaded (no route reads it). */
export interface HistoryChoice {
  readonly consolidationKey: string;
  readonly contract: string;
  readonly tokenId: number;
  readonly subscribed: boolean;
  readonly subscribedCount: number;
  readonly automaticSubscription: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HistoryFile {
  readonly format: typeof HISTORY_FORMAT;
  readonly cutAt: string;
  readonly logs: readonly HistoryLog[];
  readonly pastChoices: readonly HistoryChoice[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    )) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        out[key] = canonical(v);
      }
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Not a finite number: ${value}`);
  }
  return value;
}

/** Any value as canonical JSON: object keys sorted, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** The file's bytes: canonical JSON and a final newline. */
export function serializeCanonical(file: OpeningFile | HistoryFile): string {
  return `${canonicalJson(file)}\n`;
}

export function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** Parses a file and checks that its bytes are canonical. */
export function parseCanonical<T extends OpeningFile | HistoryFile>(
  bytes: string,
  format: T['format']
): T {
  const parsed = JSON.parse(bytes) as T;
  if (parsed.format !== format) {
    throw new Error(`Expected format ${format}, got ${String(parsed.format)}`);
  }
  if (serializeCanonical(parsed) !== bytes) {
    throw new Error('The file is not in canonical form');
  }
  return parsed;
}
