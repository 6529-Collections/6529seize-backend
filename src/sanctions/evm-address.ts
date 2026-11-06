const EVM_ADDRESS_EXACT = /^0x[0-9a-fA-F]{40}$/;

/**
 * An EVM address inside free text. The address must not touch another ASCII
 * letter or digit on either side, so a run of glued addresses (82+ hex
 * characters) or a longer hash never yields a match. The leading boundary is
 * a capture group because lookbehind is not available for every target.
 */
const EVM_ADDRESS_IN_TEXT =
  /(^|[^0-9A-Za-z])(0x[0-9a-fA-F]{40})(?![0-9A-Za-z])/g;

/** An upper-case ticker such as `ETH`, `BSC` or `USDT` right before an address. */
const TICKER_BEFORE = /(?:^|[^0-9A-Za-z])([A-Z][A-Z0-9]{1,5})\s*[:-]?\s*$/;
const TICKER_WINDOW = 24;

export interface EvmAddressMatch {
  /** Lowercase `0x` + 40 hex. */
  readonly address: string;
  /** Exactly as written in the source. */
  readonly raw: string;
  /** Index of `raw` in the text. */
  readonly index: number;
}

/**
 * Normalizes an EVM address: trims, requires `0x` + 40 hex characters and
 * lowercases. EIP-55 checksums are not required or verified, because an
 * authority's published bytes are matched as published.
 */
export function normalizeEvmAddress(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!EVM_ADDRESS_EXACT.test(trimmed)) {
    return null;
  }
  return trimmed.toLowerCase();
}

/** Every boundary-checked EVM address in `text`, in order of appearance. */
export function extractEvmAddresses(text: string): EvmAddressMatch[] {
  const matches: EvmAddressMatch[] = [];
  const pattern = new RegExp(EVM_ADDRESS_IN_TEXT.source, 'g');
  let match = pattern.exec(text);
  while (match !== null) {
    const raw = match[2];
    matches.push({
      address: raw.toLowerCase(),
      raw,
      index: match.index + match[1].length
    });
    match = pattern.exec(text);
  }
  return matches;
}

/**
 * The upper-case ticker written immediately before an address, if any
 * (for example `ETH: 0x…` or `Digital Currency Address - ETH 0x…`).
 */
export function tickerBefore(text: string, index: number): string | null {
  const window = text.slice(Math.max(0, index - TICKER_WINDOW), index);
  const match = TICKER_BEFORE.exec(window);
  return match ? match[1] : null;
}
