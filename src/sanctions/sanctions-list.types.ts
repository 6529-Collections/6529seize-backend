/**
 * Types for the 6529 sanctions list (`6529.sanctions-list.v1`).
 *
 * The normative description lives in `specs/sanctions-list-v1.md`. Field
 * names are snake_case because these objects are serialized as canonical
 * JSON and read by other implementations (desktop core, validators).
 */

export const SANCTIONS_LIST_SCHEMA = '6529.sanctions-list.v1';
export const SANCTIONS_BUILDER_ID = '6529-sanctions-builder/1';
export const SANCTIONS_CORRECTIONS_SCHEMA = '6529.sanctions-corrections.v1';

export const SANCTIONS_SOURCE_IDS = [
  'ca-sema',
  'ch-seco',
  'eu-fsf',
  'il-nbctf',
  'jp-mof',
  'kr-fsc',
  'uk-fcdo',
  'us-ofac-sdn'
] as const;

export type SanctionsSourceId = (typeof SANCTIONS_SOURCE_IDS)[number];

export type SanctionsSourceNature = 'sanctions_designation' | 'seizure_order';

export type SanctionsAcquisition = 'automatic' | 'pinned_manual';

/** A calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

export interface SanctionsListInputFile {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface SanctionsListSource {
  readonly id: SanctionsSourceId;
  readonly authority: string;
  readonly jurisdiction: string;
  readonly list_name: string;
  readonly nature: SanctionsSourceNature;
  readonly url: string;
  readonly acquisition: SanctionsAcquisition;
  readonly parser: string;
  readonly inputs: SanctionsListInputFile[];
  readonly source_published: IsoDate | null;
  readonly evm_addresses: number;
  readonly listings: number;
}

export interface SanctionsListing {
  readonly source: SanctionsSourceId;
  readonly entry_id: string;
  readonly entity: string | null;
  readonly programs: string[];
  readonly labels: string[];
  readonly listed_on: IsoDate | null;
  /** Null means open-ended. Only seizure orders carry an end date today. */
  readonly valid_until: IsoDate | null;
}

export interface SanctionsListAddress {
  readonly address: string;
  readonly listings: SanctionsListing[];
}

export interface SanctionsListV1 {
  readonly schema: typeof SANCTIONS_LIST_SCHEMA;
  readonly builder: string;
  readonly chain_family: 'evm';
  readonly sources: SanctionsListSource[];
  readonly addresses: SanctionsListAddress[];
  readonly totals: {
    readonly addresses: number;
    readonly listings: number;
    readonly sources: number;
  };
}

export interface SanctionsCorrection {
  readonly address: string;
  readonly source: SanctionsSourceId;
  readonly entry_id: string;
  readonly reason: string;
  readonly case_ref: string;
  readonly decided_on: IsoDate;
}

export interface SanctionsCorrectionsV1 {
  readonly schema: typeof SANCTIONS_CORRECTIONS_SCHEMA;
  readonly corrections: SanctionsCorrection[];
}
