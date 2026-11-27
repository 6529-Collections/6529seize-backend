import { BadRequestException } from '@/exceptions';
import type { DeferralReason } from '@/subscription-key-width/subscription-deferred-writes';

/**
 * A change refused because the key-width guard holds the key's writes back:
 * the key does not fit every subscription table, or an earlier write of it
 * still waits. It answers 400 with the guard's message, like any other bad
 * request. Its own type lets the legacy dual write after the identity switch
 * tell this expected refusal from a failure.
 */
export class SubscriptionKeyHeldBackException extends BadRequestException {
  constructor(
    message: string,
    readonly reason: DeferralReason
  ) {
    super(message);
  }
}
