/**
 * The 6529 chain's public gateway (the node's read-and-submit API mode behind
 * 6529's gateway). Shapes as the API answers them: camelCase, `0x` lowercase
 * hex for bytes, addresses and ids; 64- and 128-bit values (amounts, sums,
 * TDH, xTDH) as decimal strings; heights, slots, times and counts as numbers.
 */

export type Hex = string;

/** Which state a read came from, on every answer. */
export interface ChainReadStamp {
  readonly at: 'finalized' | 'head';
  readonly height: number;
  readonly root: Hex;
  readonly slot: number;
  /** The block's slot start, Unix ms. */
  readonly time: number;
  readonly finalizedHeight: number;
  readonly headHeight: number;
  readonly network: Hex;
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
  readonly principalId: Hex;
  readonly kind: string;
  readonly status: string;
  readonly createdHeight: number;
  readonly handle: string | null;
  readonly anchor: Hex;
  readonly primary: Hex;
  readonly primarySource: 'delegation' | 'anchor';
  /** BoundAt order; the anchor first for imported identities. */
  readonly wallets: Hex[];
  readonly profile: {
    readonly docCid: Hex;
    readonly version: number;
    readonly updatedHeight: number;
  } | null;
  readonly rep: { readonly total: string; readonly raters: number };
  readonly nic: { readonly total: string; readonly raters: number };
  readonly xtdh: string;
  readonly level: ChainLevel | null;
  readonly mergedInto: Hex | null;
  /** The 6529.io profile id it was imported from, when the API gives it. */
  readonly legacyId?: string | null;
}

export interface ChainHandle {
  readonly handle: string;
  readonly valid: boolean;
  readonly available: boolean;
  readonly status: 'free' | 'claimed' | 'reserved' | 'invalid';
  readonly principalId: Hex | null;
  readonly since: number | null;
  readonly reservedUntil: number | null;
}

export interface ChainMembershipWallet {
  readonly wallet: Hex;
  readonly principalId: Hex | null;
  readonly via?: string;
  readonly index?: number;
  readonly boundCycle?: number;
  readonly wallets?: Hex[];
  readonly leftAt?: number | null;
}

export interface ChainMembershipDay {
  readonly record: Record<string, unknown> | null;
  readonly saved: Record<string, unknown> | null;
}

export interface ChainMembershipDayWallets {
  readonly record: Record<string, unknown> | null;
  readonly wallets: { readonly wallet: Hex; readonly principalId: Hex }[];
}

export interface ChainDelegation {
  readonly scope: 'identity' | 'wallet';
  readonly holder: Hex;
  readonly collection: Hex;
  readonly delegate: Hex;
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
  readonly setBy: Hex | null;
}

export interface ChainDelegationFilters {
  readonly useCase?: number;
  readonly collection?: Hex;
  readonly delegate?: Hex;
  /** Leave out records expired at the read's block time. */
  readonly live?: boolean;
}

export type ChainDelegationQuery = ChainDelegationFilters &
  (
    | { readonly holder: Hex }
    | { readonly byDelegate: Hex }
    | { readonly byCollection: Hex }
    | { readonly byUseCase: number }
  );

export interface ChainWalletDelegations {
  readonly scope: 'wallet' | 'identity';
  readonly holder: Hex;
  readonly records: ChainDelegation[];
  readonly more: boolean;
}

export type ChainRatingMatter = 'rep' | 'nic';

export interface ChainRating {
  readonly rater: Hex;
  readonly target: Hex;
  readonly targetKind?: string;
  readonly matter: string;
  readonly category: { readonly id: Hex; readonly name: string | null };
  readonly value: string;
  readonly updatedHeight: number;
  readonly viaGrant: Hex | null;
}

export interface ChainRatingTotal {
  readonly matter: string;
  readonly category: { readonly id: Hex; readonly name: string | null };
  readonly total: string;
  readonly raters: number;
}

export interface ChainFeedRecord {
  readonly family: Hex;
  readonly name: string;
  readonly key: Hex;
  /** null: the record was deleted in this block. */
  readonly value: unknown;
  readonly keyFields?: Record<string, unknown>;
  readonly valueFields?: Record<string, unknown> | null;
}

export interface ChainFeedBlock {
  readonly height: number;
  readonly slot: number;
  readonly root: Hex;
  readonly time: number;
  readonly records: ChainFeedRecord[];
}

export interface ChainFeedPage {
  readonly from: number;
  /** Every finalized height from `from` to `through` is covered. */
  readonly through: number;
  readonly blocks: ChainFeedBlock[];
  readonly ranges?: unknown;
  /** `through + 1`: ask again from here. */
  readonly next: number;
}

export interface ChainDraftRequest {
  readonly opType: string | number;
  readonly opVersion?: number;
  readonly principal?: Hex | null;
  readonly signer?: Hex;
  readonly keyType?: number;
  readonly keyId?: Hex;
  readonly authRef?: Hex;
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
  readonly txId: Hex;
  readonly opType: number;
  readonly opName: string;
  readonly opVersion: number;
  readonly typedData: Record<string, unknown>;
  readonly unsigned: Hex;
  readonly envelope: Record<string, unknown>;
  readonly signatures: {
    readonly role: number;
    readonly keyType: number;
    readonly signer: Hex;
  }[];
  readonly fee: Record<string, unknown>;
  readonly readAt: number;
}

export interface ChainSignature {
  readonly role: number;
  readonly keyType: number;
  readonly sig: Hex;
}

export type ChainSubmitRequest =
  | { readonly signed: Hex }
  | { readonly unsigned: Hex; readonly signatures: ChainSignature[] };

export interface ChainSubmitResult {
  readonly txId: Hex;
  readonly accepted: boolean;
  readonly eligibleAt?: number;
  readonly opType?: number;
}

export interface ChainTx {
  readonly status: 'final' | 'in_block' | 'failed' | 'pending';
  readonly height?: number;
  readonly block?: Hex;
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
  readonly wallet?: Hex;
  /** With `day`: `wallets` or `identities` lists that day's rows. */
  readonly list?: 'wallets' | 'identities';
}
