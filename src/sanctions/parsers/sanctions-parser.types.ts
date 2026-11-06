import type { IsoDate } from '@/sanctions/sanctions-list.types';

export interface SanctionsInputFile {
  readonly name: string;
  readonly bytes: Buffer;
}

/** One address under one entry of one source, before merging. */
export interface RawSanctionsListing {
  readonly address: string;
  readonly entry_id: string;
  readonly entity: string | null;
  readonly programs: string[];
  readonly labels: string[];
  readonly listed_on: IsoDate | null;
  readonly valid_until: IsoDate | null;
}

export interface ParsedSanctionsSource {
  readonly source_published: IsoDate | null;
  readonly listings: RawSanctionsListing[];
  /**
   * Addresses found anywhere in the inputs by a whole-file scan. The builder
   * reports any that the structured parse did not attribute (format drift).
   */
  readonly scanned_addresses: string[];
  /**
   * Addresses the parser deliberately left out (for example wallets whose
   * only order was cancelled), so the tripwire does not report them.
   */
  readonly excluded_addresses?: string[];
}

export type SanctionsSourceParser = (
  files: ReadonlyArray<SanctionsInputFile>
) => ParsedSanctionsSource;

export class SanctionsParseError extends Error {
  constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'SanctionsParseError';
  }
}
