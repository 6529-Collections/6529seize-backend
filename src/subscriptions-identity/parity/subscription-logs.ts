/**
 * Reads the legacy subscription log lines (subscriptions_logs, served by the
 * public logs route). The texts are fixed strings written by the legacy code;
 * the parsers below match them exactly and ignore anything else.
 */

export interface SubscriptionLogEntry {
  readonly id: number;
  readonly createdAtMs: number;
  readonly log: string;
  readonly additionalInfo: string | null;
}

export type CardRowEvent =
  | { readonly kind: 'AUTO_SUBSCRIBED' }
  | { readonly kind: 'SUBSCRIBED' }
  | { readonly kind: 'UNSUBSCRIBED' }
  | { readonly kind: 'COUNT_SET'; readonly count: number }
  | { readonly kind: 'MODE_SUBSCRIBED' }
  /**
   * A daily build's line for the card. Builds write one only for subscribed
   * rows; `count` is the listed count when the row was added.
   */
  | { readonly kind: 'BUILD_LISTED'; readonly count: number | null };

/** A log line about one card's row, or null. */
export function parseCardRowEvent(
  log: string,
  tokenId: number,
  additionalInfo: string | null = null
): CardRowEvent | null {
  const id = String(tokenId);
  switch (log) {
    case `Auto-Subscribed to Meme #${id}`:
      return { kind: 'AUTO_SUBSCRIBED' };
    case `Subscribed for Meme #${id}`:
      return { kind: 'SUBSCRIBED' };
    case `Unsubscribed from Meme #${id}`:
      return { kind: 'UNSUBSCRIBED' };
    case `Subscribed to Meme #${id}`:
      return { kind: 'MODE_SUBSCRIBED' };
    default:
      break;
  }
  const count = new RegExp(
    String.raw`^Updated subscription count for Meme #${id} to x(\d+)$`
  ).exec(log);
  if (count) {
    return { kind: 'COUNT_SET', count: Number(count[1]) };
  }
  return parseBuildListed(log, id, additionalInfo);
}

const BUILD_DATE = String.raw`\d{4}-\d{2}-\d{2}`;

function parseBuildListed(
  log: string,
  id: string,
  additionalInfo: string | null
): CardRowEvent | null {
  const card = `Meme #${id} on ${BUILD_DATE}`;
  if (new RegExp(`^Added to Final Subscription for ${card}$`).test(log)) {
    const m = /Subscription Count: x(\d+)/.exec(additionalInfo ?? '');
    return { kind: 'BUILD_LISTED', count: m ? Number(m[1]) : null };
  }
  const excluded = [
    `^Insufficient Balance for ${card} - Not Added to Final Subscription$`,
    `^No Balance for ${card}$`,
    `^No Subscription Count for ${card} - Not Added to Final Subscription$`
  ];
  if (excluded.some((pattern) => new RegExp(pattern).test(log))) {
    return { kind: 'BUILD_LISTED', count: null };
  }
  return null;
}

/**
 * The card row's automatic_subscription flag, from its events newest first.
 * "Auto-Subscribed" sets it; a manual subscribe or count change clears it.
 * "Unsubscribed from Meme #N" is written both by a manual unsubscribe (which
 * clears it) and by a mode change to Manual (which keeps it), with the same
 * text, so an older event decides and the answer is marked ambiguous.
 */
export function cardRowAutomaticFlag(newestFirst: readonly CardRowEvent[]): {
  readonly automatic: boolean | null;
  readonly ambiguous: boolean;
} {
  let ambiguous = false;
  for (const event of newestFirst) {
    switch (event.kind) {
      case 'AUTO_SUBSCRIBED':
        return { automatic: true, ambiguous };
      case 'SUBSCRIBED':
      case 'COUNT_SET':
        return { automatic: false, ambiguous };
      case 'UNSUBSCRIBED':
        ambiguous = true;
        break;
      default:
        break;
    }
  }
  return { automatic: null, ambiguous };
}

export type BuildLogDecision =
  | {
      readonly kind: 'ADDED';
      readonly date: string;
      readonly airdropAddress: string;
      readonly count: number;
      readonly balance: number;
    }
  | {
      readonly kind: 'INSUFFICIENT_BALANCE';
      readonly date: string;
      readonly balance: number;
    }
  | { readonly kind: 'NO_BALANCE'; readonly date: string }
  | { readonly kind: 'NO_COUNT'; readonly date: string };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The daily build's line for one card on one date, or null. */
export function parseBuildDecision(
  entry: Pick<SubscriptionLogEntry, 'log' | 'additionalInfo'>,
  tokenId: number,
  date: string
): BuildLogDecision | null {
  const card = escapeRegex(`Meme #${tokenId} on ${date}`);
  const info = entry.additionalInfo ?? '';
  if (new RegExp(`^Added to Final Subscription for ${card}$`).test(entry.log)) {
    const m =
      /^Airdrop Address: (\S+) - Subscription Count: x(\d+) - Balance: (\S+) ETH$/.exec(
        info
      );
    if (!m) {
      return null;
    }
    return {
      kind: 'ADDED',
      date,
      airdropAddress: m[1].toLowerCase(),
      count: Number(m[2]),
      balance: Number(m[3])
    };
  }
  if (
    new RegExp(
      `^Insufficient Balance for ${card} - Not Added to Final Subscription$`
    ).test(entry.log)
  ) {
    const m = /^Balance: (\S+) ETH$/.exec(info);
    return {
      kind: 'INSUFFICIENT_BALANCE',
      date,
      balance: m ? Number(m[1]) : Number.NaN
    };
  }
  if (new RegExp(`^No Balance for ${card}$`).test(entry.log)) {
    return { kind: 'NO_BALANCE', date };
  }
  if (
    new RegExp(
      `^No Subscription Count for ${card} - Not Added to Final Subscription$`
    ).test(entry.log)
  ) {
    return { kind: 'NO_COUNT', date };
  }
  return null;
}

export type ModeEvent =
  | { readonly kind: 'AUTOMATIC'; readonly automatic: boolean }
  | { readonly kind: 'ALL_EDITIONS'; readonly all: boolean };

export function parseModeEvent(log: string): ModeEvent | null {
  switch (log) {
    case 'Subscription Mode set to Automatic':
      return { kind: 'AUTOMATIC', automatic: true };
    case 'Subscription Mode set to Manual':
      return { kind: 'AUTOMATIC', automatic: false };
    case 'Edition preference set to All eligible editions':
      return { kind: 'ALL_EDITIONS', all: true };
    case 'Edition preference set to One edition':
      return { kind: 'ALL_EDITIONS', all: false };
    default:
      return null;
  }
}
