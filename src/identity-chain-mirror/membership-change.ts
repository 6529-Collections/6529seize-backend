import { RequestContext } from '@/request.context';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';

/**
 * A change in which wallets share an identity, as the identity mirror writes
 * it to address_consolidation_keys and identities.consolidation_key. Every
 * handler runs inside the mirror's transaction, so its writes commit or roll
 * back with the new keys.
 */
export interface MembershipChange {
  /** The chain height the mirror applied. */
  readonly height: number;
  /**
   * Lowercase: each wallet whose key changed, and every other wallet of the
   * rows it left and joined, before and after.
   */
  readonly wallets: string[];
  /** wallet -> its consolidation key before (a wallet with no row: itself). */
  readonly keysBefore: Record<string, string>;
  /** wallet -> its consolidation key after. */
  readonly keysAfter: Record<string, string>;
}

export type MembershipChangeHandler = (
  change: MembershipChange,
  ctx: RequestContext
) => Promise<void>;

/**
 * The holdings loops (nftOwnersLoop, aggregatedActivityLoop, and through
 * them ownersBalancesLoop) group these wallets again from
 * address_consolidation_keys. Throws without the mirror's transaction.
 */
export const queueHoldings: MembershipChangeHandler = async (change, ctx) => {
  await transferReconciliationDb.enqueue(
    change.wallets,
    ['owners', 'activity'],
    ctx
  );
};

/**
 * The handlers the mirror calls on every membership change, in order. A lane
 * that keys its own rows by consolidation key adds its handler here.
 */
export const MEMBERSHIP_CHANGE_HANDLERS: readonly MembershipChangeHandler[] = [
  queueHoldings
];
