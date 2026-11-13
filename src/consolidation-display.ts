import { ethTools } from './eth-tools';

// Matches the consolidation_display column width (varchar(500)).
export const CONSOLIDATION_DISPLAY_MAX_LENGTH = 500;

const SEPARATOR = ' - ';

export interface ConsolidationDisplayPart {
  readonly wallet: string;
  // ENS display name, or the wallet address when there is none.
  readonly display: string;
}

export function shortFormatIfAddress(address: string): string {
  if (!address || !ethTools.isEthAddress(address)) {
    return address;
  }
  return `${address.substring(0, 5)}...${address.substring(
    address.length - 3
  )}`;
}

/**
 * Joins a consolidation's display names. Four ENS names of up to 150
 * characters each can exceed the column, so while the result is too long the
 * longest remaining name is replaced by its shortened wallet address.
 */
export function formatConsolidationDisplay(
  parts: ConsolidationDisplayPart[],
  maxLength: number = CONSOLIDATION_DISPLAY_MAX_LENGTH
): string {
  if (parts.length === 1) {
    return parts[0].display;
  }
  const displays = parts.map((part) => shortFormatIfAddress(part.display));
  const shortWallets = parts.map((part) => shortFormatIfAddress(part.wallet));
  while (displays.join(SEPARATOR).length > maxLength) {
    const longest = longestReplaceableIndex(displays, shortWallets);
    if (longest === null) {
      break;
    }
    displays[longest] = shortWallets[longest];
  }
  return displays.join(SEPARATOR);
}

function longestReplaceableIndex(
  displays: string[],
  shortWallets: string[]
): number | null {
  let longest: number | null = null;
  displays.forEach((display, index) => {
    if (display === shortWallets[index]) {
      return;
    }
    if (longest === null || display.length > displays[longest].length) {
      longest = index;
    }
  });
  return longest;
}
