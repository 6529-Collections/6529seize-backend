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

/** Whole blocks of the feed, and the height to read next. */
export interface WholeBlocks {
  /** Each with all its records (the family filter's). */
  readonly blocks: ChainFeedBlock[];
  /** The next height to read; nothing below it is left out. */
  readonly nextHeight: number;
  /** Nothing past the start: the finalized head is reached. */
  readonly atHead: boolean;
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
  if (first.atHead) return { blocks: [], nextHeight: from, atHead: true };
  const blocks = [...first.blocks];
  let page = first;
  for (;;) {
    const cut = blocks[blocks.length - 1];
    if (!cut || cut.complete !== false) {
      return { blocks, nextHeight: page.nextHeight, atHead: false };
    }
    const rest = await readFeedPage(gateway, page.next, opts);
    const head = rest?.blocks[0];
    if (
      !rest ||
      String(rest.next) === String(page.next) ||
      !head ||
      Number(head.height) !== Number(cut.height)
    ) {
      return {
        blocks: blocks.slice(0, -1),
        nextHeight: Number(cut.height),
        atHead: false
      };
    }
    blocks[blocks.length - 1] = {
      ...head,
      records: [...cut.records, ...head.records],
      recordsFrom: cut.recordsFrom ?? 0
    };
    blocks.push(...rest.blocks.slice(1));
    page = rest;
  }
}
