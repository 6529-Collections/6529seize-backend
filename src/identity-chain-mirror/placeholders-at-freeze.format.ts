/**
 * The "placeholders at freeze" file, as its reader sees it: every
 * placeholder profile as stored at the identity freeze, for 6529.io's
 * rebuild check to restore the ones no 6529-chain identity takes.
 *
 * A copy of the format module of the job that writes the file
 * (src/dbDumpsDaily/placeholders-at-freeze.format.ts), kept until that job
 * lands. Then this file goes, and the identity rebuild imports the format
 * string and the line type from there.
 *
 * Gzipped NDJSON: a header line, then one line per placeholder, sorted by
 * profile id (bytewise), each line ending in a newline. The object is named
 * by the sha256 of its gzipped bytes; its manifest also gives the sha256 of
 * the NDJSON before gzip.
 */

export const PLACEHOLDERS_FORMAT = '6529.placeholders-at-freeze.v1';

/** First line of the "placeholders at freeze" file. */
export interface PlaceholdersAtFreezeHeader {
  readonly format: typeof PLACEHOLDERS_FORMAT;
  /** The freeze; for a rehearsal (never used), the snapshot's time. */
  readonly freeze_ms: number;
  /**
   * The newest TDH block at the snapshot (tdh_blocks): the run that last
   * wrote the identities rows and their wallets. Null when there is none.
   */
  readonly tdh_block: number | null;
  readonly exporter_revision: string;
  /** Lines after this one. */
  readonly count: number;
}

/**
 * The identities row of a placeholder profile, with that row's wallets.
 * No TDH, base TDH rate, xTDH or level: the TDH area owns those columns.
 */
export interface PlaceholderIdentity {
  readonly consolidation_key: string;
  readonly primary_address: string;
  readonly handle: string | null;
  readonly normalised_handle: string | null;
  readonly pfp: string | null;
  readonly banner1: string | null;
  readonly banner2: string | null;
  readonly classification: string | null;
  readonly sub_classification: string | null;
  readonly rep: number;
  readonly cic: number;
  /** The address_consolidation_keys rows of the consolidation key, sorted. */
  readonly wallets: string[];
}

/**
 * Each following line: a placeholder profile (normalised_handle equal to
 * concat('id-', lower(primary_wallet))) as stored at the freeze, with its
 * identities row and that row's wallets. Every placeholder, imported or
 * not: the rebuild restores the ones no chain identity takes.
 */
export interface PlaceholderAtFreezeLine {
  readonly profile_id: string;
  /** primary_wallet as stored, not lowercased. */
  readonly wallet: string;
  readonly handle: string;
  readonly normalised_handle: string;
  /** Unix milliseconds of the stored UTC DATETIME: whole seconds. */
  readonly created_at_ms: number;
  readonly created_by_wallet: string;
  readonly updated_at_ms: number | null;
  readonly updated_by_wallet: string | null;
  readonly pfp_url: string | null;
  readonly banner_1: string | null;
  readonly banner_2: string | null;
  readonly website: string | null;
  readonly classification: string | null;
  readonly sub_classification: string | null;
  /** Null when the profile has no identities row at the freeze. */
  readonly identity: PlaceholderIdentity | null;
}
