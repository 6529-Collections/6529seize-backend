import type { MirrorState } from './identity-chain-mirror.db';
import { identityRowsReached } from './mirror-reached';

/** A mirror state past height 100, nothing left; parts overridden below. */
function state(over: Partial<MirrorState> = {}): MirrorState {
  return {
    sync_phase: null,
    last_full_sync_at: 1,
    next_height: 101,
    bindings_next_height: 101,
    retry: { principals: [], targets: [], wallets: [] },
    ...over
  } as MirrorState;
}

describe('identityRowsReached', () => {
  it('holds at a height the feed and the bindings are past', () => {
    expect(identityRowsReached(state(), 100)).toBe(true);
    expect(identityRowsReached(state(), 99)).toBe(true);
  });

  it('does not hold at the next height, or with no state', () => {
    expect(identityRowsReached(state(), 101)).toBe(false);
    expect(identityRowsReached(null, 0)).toBe(false);
  });

  it('waits for the bindings, a full sync, and identities or wallets to retry', () => {
    expect(identityRowsReached(state({ bindings_next_height: 100 }), 100)).toBe(
      false
    );
    expect(identityRowsReached(state({ sync_phase: 'IDENTITIES' }), 100)).toBe(
      false
    );
    expect(identityRowsReached(state({ last_full_sync_at: null }), 100)).toBe(
      false
    );
    expect(
      identityRowsReached(
        state({ retry: { principals: ['0x01'], targets: [], wallets: [] } }),
        100
      )
    ).toBe(false);
    expect(
      identityRowsReached(
        state({ retry: { principals: [], targets: [], wallets: ['0x02'] } }),
        100
      )
    ).toBe(false);
  });

  it('does not wait for rating targets to retry', () => {
    expect(
      identityRowsReached(
        state({ retry: { principals: [], targets: ['0x03'], wallets: [] } }),
        100
      )
    ).toBe(true);
  });
});
