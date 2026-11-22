/**
 * A TDH day as the 6529 chain holds it: the `TdhDay` record's fields (P61
 * 5.2, 5.3) and the day's wallet and token lists (P28 4.3, 4.12).
 *
 * Addresses, cids and roots are lowercase `0x` hex. TDH values are whole TDH
 * (P26's integer `final`); P26 keeps them below 2^53, so they are numbers
 * here and every parser checks `Number.isSafeInteger`. Token ids are uint256,
 * so they stay decimal strings.
 */
export interface TdhDayHeader {
  /** The day number N: `t_N div 86400`. */
  readonly cycleDay: number;
  /** t_N, Unix seconds: the UTC midnight that closes the day. */
  readonly boundary: number;
  readonly tdhRuleId: string;
  /** B_N, the last Ethereum block before the boundary. */
  readonly cutoffNumber: number;
  readonly cutoffHash: string;
  readonly cutoffTimestamp: number;
  readonly walletRoot: string;
  /** The number of leaves in the wallet list. */
  readonly walletCount: number;
  readonly identityCount: number;
  readonly totalTdh: number;
  readonly tokenRoot: string;
  readonly tokenCount: number;
}

/** Where and when the chain applied the day; absent in a fixture. */
export interface TdhDayApply {
  readonly applyHeight: number | null;
  readonly applyBlockHash: string | null;
  readonly applyTimeMs: number | null;
  readonly finalizedHeight: number | null;
}

export interface TdhChainDayInfo {
  readonly header: TdhDayHeader;
  readonly apply: TdhDayApply;
}

/** P28 4.3's leaf. `walletCount` is the size of the wallet's cluster. */
export interface TdhWalletLeaf {
  readonly wallet: string;
  readonly cid: string;
  readonly identityTdh: number;
  readonly walletTdh: number;
  readonly walletCount: number;
}

/** P28 4.12's leaf: an identity's boosted TDH on one token, above zero. */
export interface TdhTokenLeaf {
  readonly cid: string;
  readonly contract: string;
  readonly tokenId: string;
  readonly tokenTdh: number;
}

/** A day with its lists. `tokenLeaves` is null when they weren't served. */
export interface TdhChainDay extends TdhChainDayInfo {
  readonly walletLeaves: readonly TdhWalletLeaf[];
  readonly tokenLeaves: readonly TdhTokenLeaf[] | null;
}
