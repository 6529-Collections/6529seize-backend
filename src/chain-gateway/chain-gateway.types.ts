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
  /**
   * The chain the read must be of (a walk pinned to one chain): an answer
   * of another throws `wrong_network`, so a relaunch is never crossed
   * silently.
   */
  readonly network?: string;
}

/**
 * A page of a list. Without `height` each page follows the head, so a walk
 * over many pages can span heights: pass the first page's `read.height` as
 * `height` to read every page of one state.
 */
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
  /**
   * The finalized height reads pin to: the highest seen on this network,
   * never going back when a node behind the others answers the status.
   */
  readonly finalizedHeight: number;
  /** The finalized height the node that answered the status is at. */
  readonly nodeFinalizedHeight?: number;
  /**
   * The finalized block's slot start, Unix ms, when the pin is the
   * answering node's own finalized height; null when the pin is above it.
   */
  readonly finalizedTime: number | null;
  /** The answering node's finalized block's slot start, Unix ms. */
  readonly nodeFinalizedTime?: number;
  /** Heights `?height=` can still pin. */
  readonly pinnable: { readonly from: number; readonly to: number } | null;
  /** The chain's network id; another one means another chain (a relaunch). */
  readonly network: string | null;
  /**
   * Whether the node that answered is ready (its head current, its driver
   * passing). One that isn't still answers its finalized state, which the
   * client reads; always set by the client.
   */
  readonly ready?: boolean;
  /** Why the node isn't ready, when it isn't. */
  readonly notReady?: string | null;
}

export interface ChainStatus {
  readonly api: string;
  readonly node: string;
  readonly ready: boolean;
  readonly notReady?: string | null;
  readonly lagSlots?: number | null;
  /** Null while the node has no state to read yet. */
  readonly head: ChainReadStamp | null;
  readonly finalized: ChainReadStamp | null;
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
  readonly tdhDay: number;
}

/** A page of identities by level, highest `raw` first. */
export interface ChainLevelRanking {
  /** The finalized height the ranking was built at. */
  readonly rankedAt: number;
  readonly count: number;
  readonly rows: {
    readonly rank: number;
    readonly level: number;
    readonly raw: string;
    readonly identity: ChainIdentity;
  }[];
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
  /**
   * Null when the answering node hasn't copied the read's TDH day lists
   * yet: not "no level", so a caller keeps the value it had.
   */
  readonly level: ChainLevel | null;
  readonly mergedInto: string | null;
  /** The 6529.io profile id it was imported from, when the API gives it. */
  readonly legacyId?: string | null;
  /**
   * The wallet that made the identity, fixed for its life: for one the
   * import created, the file's `primary` (its anchor at the import); for
   * one made on the chain, IDENTITY_CREATE's signer. Null when it has
   * neither; absent from a gateway older than the field.
   */
  readonly founder?: string | null;
}

export interface ChainHandle {
  readonly handle: string;
  readonly valid: boolean;
  readonly available: boolean;
  readonly status: 'free' | 'claimed' | 'reserved' | 'invalid' | 'other';
  /** For an invalid handle: the rule it breaks. */
  readonly rule?: string;
  readonly principalId: string | null;
  readonly since: number | null;
  /** When a reservation ends (a decimal string), for a reserved handle. */
  readonly reservedUntil: string | null;
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
  /** For a wallet bound to none: when it left, and the identity it left. */
  readonly leftAt?: { readonly leftMs: number; readonly from: string } | null;
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
  /**
   * The record's last writer in its block: a transaction, or system work
   * (the import, the rating scan, the binding step, ...); null for a block
   * the node recorded before it kept writers.
   */
  readonly writer?: ChainFeedWriter | null;
}

export type ChainFeedWriter =
  | {
      readonly kind: 'tx';
      readonly txId: string;
      readonly opType: number | string;
      readonly opName: string;
    }
  | {
      readonly kind: 'system';
      readonly step:
        | 'IMPORT'
        | 'RATING_SCAN'
        | 'BINDING'
        | 'MEMBERSHIP_DAY'
        | 'QUEUE'
        | 'SYSTEM';
    };

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
   * block again with the rest of its records (from `recordsFrom`). Always
   * set in a page the client returns (it refuses a page without it);
   * optional for callers' own blocks.
   */
  readonly complete?: boolean;
  /**
   * The position in the block's writes its records here start at: the
   * cursor's index for the block a page was asked from inside, else 0.
   */
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
   * The next height to read whole (`through + 1`, never below the height
   * asked from): what a caller keeps between runs, rather than `next`.
   * Reading from it again repeats at most the block a page ended inside.
   * A `height:index` cursor holds only for the families filter it was
   * read with: never pass it with another.
   */
  readonly nextHeight: number;
  /**
   * Nothing at or past the height asked from: the node's finalized head is
   * reached (a node behind another gives `through` below it).
   */
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
  /**
   * Best left out: the draft then reserves step 9's bound plus 150,000 RU.
   * A value below the bound is raised to the bound alone.
   */
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
  /** With `day`: `wallets`, `identities` or `tokens` lists that day's rows. */
  readonly list?: 'wallets' | 'identities' | 'tokens';
}
