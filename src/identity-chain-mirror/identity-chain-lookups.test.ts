import { IdentityChainMirrorDb } from './identity-chain-mirror.db';
import { IdentityChainLookups } from './identity-chain-lookups';

const W = '0x' + '01'.repeat(20);
const P1 = '0x' + 'aa'.repeat(32);
const P2 = '0x' + 'bb'.repeat(32);
const PROFILE = '00000000-0000-4000-8000-000000000001';

function setup(nextHeight: number | null) {
  const db = {
    getState: jest.fn(async () =>
      nextHeight === null ? null : { next_height: nextHeight }
    ),
    walletBindings: jest.fn(
      async () =>
        new Map([[W, { wallet: W, principal_id: P2, bound_from_height: 50 }]])
    ),
    principalOfProfile: jest.fn(async () => null as string | null)
  };
  const gateway = {
    getIdentityByLegacyProfileId: jest.fn(async () => null as unknown),
    getMembershipWalletHistory: jest.fn(async () => ({
      wallet: W,
      changes: [
        { height: 10, principalId: P1 },
        { height: 30, principalId: null },
        { height: 50, principalId: P2 }
      ]
    }))
  };
  const lookups = new IdentityChainLookups(
    db as unknown as IdentityChainMirrorDb,
    gateway as never
  );
  return { db, gateway, lookups };
}

describe('walletPrincipalAt', () => {
  it("answers from the mirror's bindings within what it has followed", async () => {
    const { gateway, lookups } = setup(101);
    expect(await lookups.walletPrincipalAt(W.toUpperCase(), 50)).toBe(P2);
    expect(await lookups.walletPrincipalAt(W, 100)).toBe(P2);
    expect(gateway.getMembershipWalletHistory).not.toHaveBeenCalled();
  });

  it('asks the chain before the binding, or past the mirror', async () => {
    const { gateway, lookups } = setup(101);
    expect(await lookups.walletPrincipalAt(W, 20)).toBe(P1);
    expect(await lookups.walletPrincipalAt(W, 35)).toBeNull();
    expect(await lookups.walletPrincipalAt(W, 5)).toBeNull();
    expect(await lookups.walletPrincipalAt(W, 101)).toBe(P2);
    expect(gateway.getMembershipWalletHistory).toHaveBeenCalledTimes(4);
  });

  it('asks the chain before the first full sync', async () => {
    const { gateway, lookups } = setup(null);
    expect(await lookups.walletPrincipalAt(W, 60)).toBe(P2);
    expect(gateway.getMembershipWalletHistory).toHaveBeenCalledTimes(1);
  });
});

describe('principalIdOfProfile', () => {
  it("takes the mirror's mapping, else the import's", async () => {
    const { db, gateway, lookups } = setup(101);
    db.principalOfProfile.mockResolvedValueOnce(P1.toUpperCase());
    expect(await lookups.principalIdOfProfile(PROFILE.toUpperCase())).toBe(
      P1.toLowerCase()
    );
    expect(db.principalOfProfile).toHaveBeenCalledWith(PROFILE);
    gateway.getIdentityByLegacyProfileId.mockResolvedValueOnce({
      principalId: P2
    });
    expect(await lookups.principalIdOfProfile(PROFILE)).toBe(P2);
    expect(await lookups.principalIdOfProfile(PROFILE)).toBeNull();
  });
});
