import { extractEvmAddresses, tickerBefore } from '@/sanctions/evm-address';
import { decodeUtf8 } from '@/sanctions/sanctions-xml';
import { compareCodePoints } from '@/sanctions/sanctions-text';
import {
  SanctionsInputFile,
  SanctionsParseError
} from '@/sanctions/parsers/sanctions-parser.types';

export interface TextAddress {
  readonly address: string;
  readonly label: string | null;
}

/** Boundary-checked addresses in a free-text field, with any ticker written before each. */
export function addressesInText(text: string): TextAddress[] {
  return extractEvmAddresses(text).map((match) => ({
    address: match.address,
    label: tickerBefore(text, match.index)
  }));
}

/** Distinct addresses found by scanning the decoded text of every input file. */
export function scanFilesForAddresses(
  files: ReadonlyArray<SanctionsInputFile>
): string[] {
  const seen: Record<string, true> = {};
  for (const file of files) {
    for (const match of extractEvmAddresses(decodeUtf8(file.bytes))) {
      seen[match.address] = true;
    }
  }
  return Object.keys(seen).sort(compareCodePoints);
}

export function requireSingleFile(
  source: string,
  files: ReadonlyArray<SanctionsInputFile>
): SanctionsInputFile {
  if (files.length !== 1) {
    throw new SanctionsParseError(
      source,
      `expected exactly one input file, got ${files.length}`
    );
  }
  return files[0];
}

export function labelsOf(label: string | null): string[] {
  return label ? [label] : [];
}
