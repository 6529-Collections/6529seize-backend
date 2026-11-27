import type { MirrorState } from './identity-chain-mirror.db';

/**
 * Whether the identity mirror's identities rows and wallets stand as of
 * chain height `height`: a full sync ended and none is under way, the feed
 * and the wallet bindings have been followed past the height, and no
 * identity or wallet waits to be tried again. A writer that resolves a
 * listed address to its identity as of a height (the waves mirror's group
 * lists) waits until this holds, so a mirror catching up and a rebuild
 * resolve it alike. The rating events, level sweeps and ledger rebuilds
 * don't change which identity holds a wallet, so they aren't waited for.
 */
export function identityRowsReached(
  state: MirrorState | null,
  height: number
): boolean {
  if (!state) return false;
  const next = height + 1;
  return (
    state.sync_phase === null &&
    state.last_full_sync_at !== null &&
    state.next_height !== null &&
    Number(state.next_height) >= next &&
    state.bindings_next_height !== null &&
    Number(state.bindings_next_height) >= next &&
    state.retry.principals.length === 0 &&
    state.retry.wallets.length === 0
  );
}
