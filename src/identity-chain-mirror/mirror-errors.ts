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
