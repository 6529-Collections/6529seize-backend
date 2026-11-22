/**
 * `6529.identity-export.v1`: the input of the Identities v1 file the 6529
 * chain imports at the identity freeze. The snapshot tooling builds the file
 * from it; a second exporter reads 6529.io's public API into the same shape,
 * and the two must agree. Field names follow 6529.io's tables. Addresses are
 * lowercase 0x hex; times are Unix milliseconds.
 */
export const IDENTITY_EXPORT_FORMAT = '6529.identity-export.v1';

export type IdentityExportScope = 'handle' | 'wallets' | 'rating' | 'waves';

export interface IdentityExportStatement {
  readonly id: string;
  readonly statement_group: string;
  readonly statement_type: string;
  readonly statement_value: string;
  readonly statement_comment: string | null;
  readonly created_at_ms: number;
}

export interface IdentityExportIdentity {
  /** profiles.external_id; null when the identity has no profile. */
  readonly profile_id: string | null;
  /** profiles.handle as stored (case kept); null without a profile. */
  readonly handle: string | null;
  readonly normalised_handle: string | null;
  readonly primary_address: string;
  /** The consolidation's wallets, ascending, one or more. */
  readonly wallets: string[];
  readonly consolidation_key: string;
  readonly classification: string | null;
  readonly sub_classification: string | null;
  readonly pfp: string | null;
  readonly banner1: string | null;
  readonly banner2: string | null;
  readonly website: string | null;
  readonly statements: IdentityExportStatement[];
  readonly tdh: number;
  /** Unrounded; the builder floors it. */
  readonly xtdh: number;
  /** 6529.io's REP without the help bot's credits, as the chain counts it. */
  readonly rep: number;
  readonly cic: number;
  /** The chain's level: from level_raw. */
  readonly level: number;
  /** REP + TDH, without xTDH or help-bot credits; null when 6529.io has none. */
  readonly level_raw: number | null;
  readonly scope: IdentityExportScope[];
  /**
   * The ProfileDoc `cms` value (the profile site), from the profile site
   * export; absent when the profile has none or none was given.
   */
  readonly cms?: unknown;
}

export interface IdentityExportRating {
  readonly rater_profile_id: string;
  readonly target_profile_id: string;
  readonly matter: 'REP' | 'CIC';
  /** REP: matter_category as stored; CIC: empty. */
  readonly category: string;
  /** The value as stored, never reduced. */
  readonly rating: number;
  readonly last_modified_ms: number | null;
}

export interface IdentityExportDelegation {
  readonly from_address: string;
  readonly to_address: string;
  readonly collection: string;
  readonly use_case: number;
  /** Unix seconds. */
  readonly expiry: number;
  readonly all_tokens: boolean;
  /** Decimal; null for an all-tokens delegation. */
  readonly token_id: string | null;
  readonly block: number;
}

export interface IdentityExportHeader {
  readonly format: typeof IDENTITY_EXPORT_FORMAT;
  readonly source: 'database';
  readonly exporter_revision: string;
  readonly started_at_ms: number;
  readonly finished_at_ms: number;
  readonly freeze_ms: number | null;
  readonly tdh_block: number | null;
}
