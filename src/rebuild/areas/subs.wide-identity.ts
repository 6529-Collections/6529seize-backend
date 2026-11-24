/**
 * The subscriptions seeds' wide identity: 15 wallets bound to one
 * principal. Its consolidation key (644 characters) fits
 * address_consolidation_keys but not the narrowest legacy key column (567),
 * so the key-width guard queues its top-ups whole, and the queue's TOP_UP
 * rows are compared against a real one. Placeholder addresses, profile and
 * principal. The wallets, 0x…d0 to 0x…de, are no other fixture's: the
 * records service's wallet is 0x…a1 and the other seeds' are below 0xd0.
 */
export const WIDE_WALLETS: readonly string[] = Array.from(
  { length: 15 },
  (_, i) => `0x${(0xd0 + i).toString(16).padStart(40, '0')}`
);

/** Its consolidation key: its wallets, joined. */
export const WIDE_KEY = WIDE_WALLETS.join('-');

export const WIDE_PROFILE_ID = 'rebuild-subs-wide';

export const WIDE_PRINCIPAL = `0x${'d0'.padStart(64, '0')}`;

/**
 * Its top-up before the switch: queued whole, then credited at the cut.
 * Under the mint price, so automatic mode stays off and the identity is on
 * no card's list: the other seeds' lists stay as they are.
 */
export const WIDE_TOP_UP = { wallet: WIDE_WALLETS[0], amount: '0.05' };
