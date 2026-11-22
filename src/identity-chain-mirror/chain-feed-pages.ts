import {
  ChainGatewayClient,
  ChainGatewayError
} from '@/chain-gateway/chain-gateway.client';
import {
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
