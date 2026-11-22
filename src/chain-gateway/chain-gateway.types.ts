/**
 * The 6529 chain's public gateway (the node's read-and-submit API mode behind
 * 6529's gateway). Shapes as the API answers them: camelCase, `0x` lowercase
 * hex for bytes, addresses and ids; 64- and 128-bit values (amounts, sums,
 * TDH, xTDH) as decimal strings; heights, slots, times and counts as numbers.
 */

/** Which state a read came from, on every answer. */
export interface ChainReadStamp {
  readonly at: 'finalized' | 'head';
  readonly height: number;
  readonly root: string;
  readonly slot: number;
  /** The block's slot start, Unix ms. */
  readonly time: number;
  readonly finalizedHeight: number;
  readonly headHeight: number;
  readonly network: string;
}

/** One answer: its data, the state it read and the next page's cursor. */
export interface ChainAnswer<T> {
  readonly read: ChainReadStamp;
  readonly data: T;
  readonly next: string | null;
}

export interface ChainReadOptions {
  /**
   * Pin the read to this height. Without it the client pins the latest
   * finalized height it knows (refreshed every few seconds), so the reads of
   * one task agree. A height the gateway no longer holds throws
   * ChainGatewayError with code `height_gone`: re-pin and restart the list.
   */
  readonly height?: number;
  /** `head` reads the unfinalized head (never cached, never pinned). */
  readonly at?: 'finalized' | 'head';
}

export interface ChainPageOptions extends ChainReadOptions {
  readonly after?: string | null;
  readonly limit?: number;
}

export interface ChainPage<T> {
  readonly items: T[];
  readonly next: string | null;
  readonly read: ChainReadStamp;
}

export interface ChainHead {
  readonly headHeight: number;
  readonly finalizedHeight: number;
  /** The finalized block's slot start, Unix ms. */
  readonly finalizedTime: number;
  /** Heights `?height=` can still pin. */
  readonly pinnable: { readonly from: number; readonly to: number } | null;
  /** The chain's network id; another one means another chain (a relaunch). */
  readonly network: string | null;
}

export interface ChainStatus {
  readonly api: string;
  readonly node: string;
  readonly ready: boolean;
  readonly head: ChainReadStamp;
  readonly finalized: ChainReadStamp;
  readonly pinnable?: { readonly from: number; readonly to: number };
  readonly ruleVersion: number;
  readonly feed?: unknown;
  readonly membershipDays?: number[];
}

export interface ChainLevel {
  readonly level: number;
  readonly raw: string;
  readonly rep: string;
  readonly tdh: string;
  readonly xtdh: string;
  readonly tdhDay: number;
}

export interface ChainIdentity {
  readonly principalId: string;
  readonly kind: string;
  readonly status: string;
  readonly createdHeight: number;
  readonly handle: string | null;
  readonly anchor: string;
  readonly primary: string;
  readonly primarySource: 'delegation' | 'anchor';
  /** BoundAt order; the anchor first for imported identities. */
  readonly wallets: string[];
  readonly profile: {
    readonly docCid: string;
    readonly version: number;
    readonly updatedHeight: number;
  } | null;
  readonly rep: { readonly total: string; readonly raters: number };
  readonly nic: { readonly total: string; readonly raters: number };
  readonly xtdh: string;
  readonly level: ChainLevel | null;
  readonly mergedInto: string | null;
  /** The 6529.io profile id it was imported from, when the API gives it. */
  readonly legacyId?: string | null;
  /**
   * The wallet that signed IDENTITY_CREATE (never changes), when the
   * gateway gives it.
   */
  readonly founder?: string | null;
}

export interface ChainHandle {
  readonly handle: string;
  readonly valid: boolean;
  readonly available: boolean;
  readonly status: 'free' | 'claimed' | 'reserved' | 'invalid';
  readonly principalId: string | null;
  readonly since: number | null;
  readonly reservedUntil: number | null;
}

export interface ChainMembershipWallet {
  readonly wallet: string;
  readonly principalId: string | null;
  /**
   * The height the wallet first joined this identity (one that left and
   * came back keeps it; the history has each change).
   */
  readonly firstBoundHeight?: number | null;
  readonly via?: string;
  readonly index?: number;
  readonly boundCycle?: number;
  readonly wallets?: string[];
  readonly leftAt?: number | null;
}

/** Every binding change of a wallet the gateway's feed holds, ascending. */
export interface ChainWalletHistory {
  readonly wallet: string;
  /** The wallet's principal at height H: the last change at or below H. */
  readonly changes: {
    readonly height: number;
    readonly principalId: string | null;
  }[];
  /**
   * The height ranges the feed holds, `[from, to]` inclusive: the history
   * is exact only within them.
   */
  readonly ranges: [number, number][];
  /** The height the gateway read at. */
  readonly readHeight: number;
}

/** The import file's entry an identity was created from. */
export interface ChainImportedIdentity {
  readonly principalId: string;
  readonly legacyId: string | null;
  readonly handle: string | null;
  readonly wallets: string[];
  readonly primary: string | null;
  /** The ProfileDoc the import wrote (hex CID), or null. */
  readonly profileDocCid: string | null;
  readonly xtdh?: string;
}

/** The document store's answer to an upload. */
export interface ChainStoredDoc {
  /** Base32 (`b...`). */
  readonly cid: string;
  readonly cid_hex: string;
  readonly codec: string;
  readonly size: number;
  readonly url?: string;
}

export interface ChainMembershipDay {
  readonly record: Record<string, unknown> | null;
  readonly saved: Record<string, unknown> | null;
}

export interface ChainMembershipDayWallets {
  readonly record: Record<string, unknown> | null;
  readonly wallets: { readonly wallet: string; readonly principalId: string }[];
}

export interface ChainDelegation {
  readonly scope: 'identity' | 'wallet';
  readonly holder: string;
  readonly collection: string;
  readonly delegate: string;
  readonly useCase: number;
  readonly allTokens: boolean;
  readonly tokenId: string;
  /** Unix seconds, decimal. */
  readonly expiry: string;
  readonly expired: boolean;
  readonly source: 'imported' | 'set';
  readonly setHeight: number;
  readonly ethBlock: number | null;
  readonly logIndex: number | null;
  readonly setBy: string | null;
}

export interface ChainDelegationFilters {
  readonly useCase?: number;
  readonly collection?: string;
  readonly delegate?: string;
  /** Leave out records expired at the read's block time. */
  readonly live?: boolean;
}

export type ChainDelegationQuery = ChainDelegationFilters &
  (
    | { readonly holder: string }
    | { readonly byDelegate: string }
    | { readonly byCollection: string }
    | { readonly byUseCase: number }
  );

export interface ChainWalletDelegations {
  readonly scope: 'wallet' | 'identity';
  readonly holder: string;
  readonly records: ChainDelegation[];
  readonly more: boolean;
}

export type ChainRatingMatter = 'rep' | 'nic';

export interface ChainRating {
  readonly rater: string;
  readonly target: string;
  readonly targetKind?: string;
  readonly matter: string;
  readonly category: { readonly id: string; readonly name: string | null };
  readonly value: string;
  readonly updatedHeight: number;
  readonly viaGrant: string | null;
}

export interface ChainRatingTotal {
  readonly matter: string;
  readonly category: { readonly id: string; readonly name: string | null };
  readonly total: string;
  readonly raters: number;
}

export interface ChainFeedRecord {
  readonly family: string;
  readonly name: string;
  readonly key: string;
  /** null: the record was deleted in this block. */
  readonly value: unknown;
  readonly keyFields?: Record<string, unknown>;
  readonly valueFields?: Record<string, unknown> | null;
  /**
   * Written by the identity import (true), by a transaction (false), or
   * unknown (null: a block that completed the import and ran transactions;
   * ask `/v1/identities/{p}/imported`).
   */
  readonly byImport?: boolean | null;
}

export interface ChainFeedBlock {
  readonly height: number;
  readonly slot: number;
  readonly root: string;
  /** The block's slot start, Unix ms. */
  readonly time: number;
  /** Set on a block that moved the identity import. */
  readonly import?: {
    readonly next: number;
    readonly count: number;
    readonly doneHeight: number | null;
    readonly completedHere: boolean;
  } | null;
  /**
   * False when the page ends inside this block: the next page gives the
   * block again with the rest of its records (from `recordsFrom`).
   */
  readonly complete?: boolean;
  /** The position in the block's writes its records here start at. */
  readonly recordsFrom?: number;
  readonly records: ChainFeedRecord[];
}

/** Where a page of the feed starts: a height, or the gateway's `next`. */
export type ChainFeedCursor = number | string;

export interface ChainFeedPage {
  readonly from: ChainFeedCursor;
  /** The last height given whole. */
  readonly through: number;
  readonly blocks: ChainFeedBlock[];
  readonly ranges?: unknown;
  /**
   * Where the next page starts, as the gateway gave it (`through + 1`, or
   * `height:index` inside a block): pass it back as it is.
   */
  readonly next: ChainFeedCursor;
  /**
   * The next height to read whole (`through + 1`): what a caller keeps
   * between runs. Reading from it again repeats at most the block a page
   * ended inside.
   */
  readonly nextHeight: number;
  /** Nothing past the start: the finalized head is reached. */
  readonly atHead: boolean;
  /** The network id of the chain the page was read from. */
  readonly network?: string | null;
}

export interface ChainDraftRequest {
  readonly opType: string | number;
  readonly opVersion?: number;
  readonly principal?: string | null;
  readonly signer?: string;
  readonly keyType?: number;
  readonly keyId?: string;
  readonly authRef?: string;
  readonly body: Record<string, unknown>;
  readonly nonce?: number;
  readonly nonceLane?: number;
  readonly validForMs?: number;
  readonly notBefore?: number;
  readonly expiresAt?: number;
  readonly maxFee?: string;
  readonly maxWork?: number;
  readonly tipPerRu?: string;
}

export interface ChainDraft {
  /** The EIP-712 digest every signature signs. */
  readonly txId: string;
  readonly opType: number;
  readonly opName: string;
  readonly opVersion: number;
  readonly typedData: Record<string, unknown>;
  readonly unsigned: string;
  readonly envelope: Record<string, unknown>;
  readonly signatures: {
    readonly role: number;
    readonly keyType: number;
    readonly signer: string;
  }[];
  readonly fee: Record<string, unknown>;
  readonly readAt: number;
}

export interface ChainSignature {
  readonly role: number;
  readonly keyType: number;
  readonly sig: string;
}

export type ChainSubmitRequest =
  | { readonly signed: string }
  | { readonly unsigned: string; readonly signatures: ChainSignature[] };

export interface ChainSubmitResult {
  readonly txId: string;
  readonly accepted: boolean;
  readonly eligibleAt?: number;
  readonly opType?: number;
}

export interface ChainTx {
  readonly status: 'final' | 'in_block' | 'failed' | 'pending';
  readonly height?: number;
  readonly block?: string;
  readonly position?: number;
  readonly opType?: number;
  readonly result?: {
    readonly code: number | string;
    readonly name: string;
    readonly detail?: number;
    readonly feePaid?: string;
    readonly ruUsed?: number;
  };
}

export interface ChainTdhQuery {
  readonly day?: number;
  readonly wallet?: string;
  /** With `day`: `wallets` or `identities` lists that day's rows. */
  readonly list?: 'wallets' | 'identities';
}
