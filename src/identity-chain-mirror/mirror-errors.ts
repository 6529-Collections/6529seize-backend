import { ChainGatewayError } from '@/chain-gateway/chain-gateway.client';

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

  /**
   * `gatewayError`: the gateway's answer this was made from (orRetryLater),
   * for a reader that handles the gateway not answering itself.
   */
  constructor(
    message: string,
    readonly reason: string,
    readonly gatewayError?: ChainGatewayError
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ChainReadRetryLater';
  }
}

/**
 * A gateway answer another node may give right: this node doesn't hold
 * the data (`not_held`), or its answer can't be read (`bad_answer`).
 */
export function isAnotherNodesToGive(error: unknown): boolean {
  return (
    error instanceof ChainGatewayError &&
    (error.code === 'not_held' || error.code === 'bad_answer')
  );
}

/**
 * `read()`, with an answer another node may give turned into
 * ChainReadRetryLater (the reason is the gateway's code).
 */
export async function orRetryLater<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isAnotherNodesToGive(error)) throw error;
    const gatewayError = error as ChainGatewayError;
    throw new ChainReadRetryLater(
      gatewayError.message,
      String(gatewayError.code),
      gatewayError
    );
  }
}
