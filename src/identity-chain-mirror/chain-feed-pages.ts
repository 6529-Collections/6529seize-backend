import {
  ChainGatewayClient,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainFeedBlock,
  ChainFeedCursor,
  ChainFeedPage
} from '@/chain-gateway/chain-gateway.types';

/** A thrown value's message. */
export function messageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

/**
 * A read the port can't answer now, which the follower should try again
 * later: it counts as one attempt at that change, the person's later
 * changes wait, and everyone else's go on. Thrown when a wallet's identity
 * at the change's height is unknown, when the store's bytes don't match
 * their CID, and when an identity's profile id can't be settled yet.
 * Gateway outages throw their own errors.
 */
export class ChainReadRetryLater extends Error {
  readonly retryLater = true;

  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ChainReadRetryLater';
  }
}

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const GONE_ATTEMPTS = 3;
const GONE_BACKOFF_MS = 500;

function isTooLarge(error: unknown): boolean {
  return (
    error instanceof ChainGatewayError &&
    (error.status === 413 || error.code === 'too_large')
  );
}

function isGone(error: unknown): boolean {
  return error instanceof ChainGatewayError && error.code === 'gone';
}

/**
 * A page of the gateway's change feed from `from`, or null when the gateway
 * no longer holds that height. `gone` is asked again, after a short wait,
 * up to three times: another node behind the gateway may hold the height.
 * An answer too large for the gateway is asked again for half the blocks,
 * down to one. Any other refusal throws.
 */
export async function readFeedPage(
  gateway: Pick<ChainGatewayClient, 'getChanges'>,
  from: ChainFeedCursor,
  opts: { limit: number; families?: string[]; sleep?: Sleep }
): Promise<ChainFeedPage | null> {
  const sleep = opts.sleep ?? realSleep;
  let limit = opts.limit;
  let gone = 0;
  for (;;) {
    try {
      return await gateway.getChanges(from, {
        limit,
        ...(opts.families ? { families: opts.families } : {})
      });
    } catch (error) {
      if (isTooLarge(error) && limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
      } else if (isGone(error) && gone + 1 < GONE_ATTEMPTS) {
        gone++;
        await sleep(GONE_BACKOFF_MS * gone);
      } else if (isGone(error)) {
        return null;
      } else {
        throw error;
      }
    }
  }
}

/**
 * Whether a page carries on the block a page ended inside: it moves on, and
 * starts with that block, from the position the cursor named.
 */
function continues(
  cut: ChainFeedBlock,
  cursor: ChainFeedCursor,
  rest: ChainFeedPage
): boolean {
  const head = rest.blocks[0];
  const position = Number(String(cursor).split(':')[1]);
  return (
    String(rest.next) !== String(cursor) &&
    !!head &&
    Number(head.height) === Number(cut.height) &&
    Number(head.recordsFrom ?? 0) === position
  );
}

/** Whole blocks of the feed, and the height to read next. */
export interface WholeBlocks {
  /** Each with all its records (the family filter's). */
  readonly blocks: ChainFeedBlock[];
  /** The next height to read; nothing below it is left out. */
  readonly nextHeight: number;
  /** Nothing past the start: the finalized head is reached. */
  readonly atHead: boolean;
  /** The network id of the chain the pages were read from. */
  readonly network: string | null;
}

/**
 * The feed's blocks from `from`, each whole: a block the gateway's page
 * ended inside is read on to its end and given once with all its records.
 * When the rest of such a block can't be read now (a gateway node behind,
 * a page that doesn't move on), that block is left out and `nextHeight` is
 * its height, so it is read again next time. Null when the gateway no
 * longer holds `from`.
 */
export async function readWholeBlocks(
  gateway: Pick<ChainGatewayClient, 'getChanges'>,
  from: number,
  opts: { limit: number; families?: string[]; sleep?: Sleep }
): Promise<WholeBlocks | null> {
  const first = await readFeedPage(gateway, from, opts);
  if (!first) return null;
  const network = first.network ?? null;
  if (first.atHead) {
    return { blocks: [], nextHeight: from, atHead: true, network };
  }
  const blocks = [...first.blocks];
  let page = first;
  for (;;) {
    const cut = blocks[blocks.length - 1];
    if (!cut || cut.complete !== false) {
      return { blocks, nextHeight: page.nextHeight, atHead: false, network };
    }
    const rest = await readFeedPage(gateway, page.next, opts);
    if (!rest || !continues(cut, page.next, rest)) {
      return {
        blocks: blocks.slice(0, -1),
        nextHeight: Number(cut.height),
        atHead: false,
        network
      };
    }
    const head = rest.blocks[0];
    blocks[blocks.length - 1] = {
      ...head,
      records: [...cut.records, ...head.records],
      recordsFrom: cut.recordsFrom ?? 0
    };
    blocks.push(...rest.blocks.slice(1));
    page = rest;
  }
}
