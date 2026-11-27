import { worldActorWallet } from '@/rebuild/manifests/probe-fixture';

/**
 * The subscriptions seeds' wide identity is the identity world's subs-wide
 * actor: 15 wallets under one identity, whose consolidation key (644
 * characters) fits address_consolidation_keys but not the narrowest legacy
 * key column (567), so the key-width guard queues its top-ups whole, and the
 * queue's TOP_UP rows are compared against a real one. The identity seed
 * writes its rows and its principal; the subscriptions seeds read it by
 * wallet and write none of them.
 *
 * Its top-up before the switch, from subs-wide-01's wallet: queued whole,
 * then credited at the cut. Under the mint price, so automatic mode stays
 * off and the identity is on no card's list: the other seeds' lists stay as
 * they are.
 */
export const WIDE_TOP_UP = {
  wallet: worldActorWallet('subs-wide-01'),
  amount: '0.05'
};
