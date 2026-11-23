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
  /** The sum of the REP ratings to the profile in this file. */
  readonly rep: number;
  /** As stored. */
  readonly cic: number;
  /** 6529.io's level table on level_raw (capped at 100: rules.level_table). */
  readonly level: number;
  /** rep + TDH, without xTDH or help-bot credits. */
  readonly level_raw: number;
  /** 6529.io's own rep, as stored (help-bot credits included). */
  readonly io_rep: number;
  /** 6529.io's own level_raw, as stored (xTDH and credits included). */
  readonly io_level_raw: number;
  /** 6529.io's own level, from io_level_raw. */
  readonly io_level: number;
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
  /** The TDH block's Ethereum timestamp. */
  readonly tdh_block_timestamp_ms: number | null;
  /** The waves list given (--extra-ids): its ids and the file's sha256. */
  readonly extra_ids: InputFile | null;
  /**
   * The profile site values given (--cms-fields): count, sha256, and the
   * profile site run's manifest that lists them.
   */
  readonly cms_fields: CmsFieldsFile | null;
  /** What was acknowledged at the freeze (--accept-*), exactly. */
  readonly acknowledged: {
    readonly over_credit: number;
    readonly edits_after_freeze: number;
    readonly ratings_changed_after_freeze: number;
    readonly profile_writes_after_freeze: number;
    readonly consolidations_after_freeze: number;
    readonly missing_extra_ids: number;
    readonly unmatched_cms: number;
    /** --accept-no-extra-ids: at the freeze without the waves list. */
    readonly no_extra_ids: boolean;
    /** --accept-bulk N: a bulk threshold other than 2000; null when not. */
    readonly bulk: number | null;
  };
}

/** An input file: how many entries it held and the sha256 of its bytes. */
export interface InputFile {
  readonly count: number;
  readonly sha256: string;
}

/** The profile site run's manifest.json that lists the cms fields file. */
export interface CmsFieldsManifest {
  /** Its bucket key; null for a local file (the CLI's --cms-manifest). */
  readonly key: string | null;
  /** The sha256 of its bytes. */
  readonly sha256: string;
}

/** The profile site values' file, and the manifest that lists it. */
export interface CmsFieldsFile extends InputFile {
  /** Null only in a rehearsal given no manifest. */
  readonly manifest: CmsFieldsManifest | null;
}
