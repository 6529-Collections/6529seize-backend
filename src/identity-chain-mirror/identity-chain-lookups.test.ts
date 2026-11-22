import { ChainWalletHistory } from '@/chain-gateway/chain-gateway.types';
import { IdentityChainMirrorDb } from './identity-chain-mirror.db';
import {
  IdentityChainLookups,
  principalInHistory,
  WalletPrincipalUnknownError
} from './identity-chain-lookups';

const W = '0x' + '01'.repeat(20);
const P1 = '0x' + 'aa'.repeat(32);
const P2 = '0x' + 'bb'.repeat(32);
const PROFILE = '00000000-0000-4000-8000-000000000001';

function history(
  ranges: [number, number][],
  readHeight = 200
): ChainWalletHistory {
  return {
    wallet: W,
    changes: [
      { height: 10, principalId: P1 },
      { height: 30, principalId: null },
      { height: 50, principalId: P2 }
    ],
    ranges,
    readHeight
  };
}

const NETWORK = '0x' + '22'.repeat(32);

function setup(
  nextHeight: number | null,
  ranges: [number, number][] = [[1, 200]],
  network: string | null = NETWORK
) {
  const db = {
    walletBindingAt: jest.fn(async () => ({
      binding: { wallet: W, principal_id: P2, bound_from_height: 50 },
      nextHeight,
      chainId: NETWORK
    })),
    principalOfProfile: jest.fn(async () => null as string | null)
  };
  const gateway = {
    getIdentityByLegacyProfileId: jest.fn(async () => null as unknown),
    getMembershipWalletHistory: jest.fn(async () => history(ranges)),
    getHead: jest.fn(async () => ({ network })),
    getMembership: jest.fn(
      async () =>
        ({ import: { completed: true, startHeight: null } }) as Record<
          string,
          unknown
        >
    )
  };
  const lookups = new IdentityChainLookups(
    db as unknown as IdentityChainMirrorDb,
    gateway as never
  );
  return { db, gateway, lookups };
}

describe('principalInHistory', () => {
  it('answers within a range the feed holds from the first blocks', () => {
    const full = history([[1, 200]]);
    expect(principalInHistory(full, 5)).toBeNull();
    expect(principalInHistory(full, 20)).toBe(P1);
    expect(principalInHistory(full, 35)).toBeNull();
    expect(principalInHistory(full, 60)).toBe(P2);
  });

  it('does not answer past the read, outside the ranges, or across a gap', () => {
    expect(principalInHistory(history([[1, 200]], 100), 150)).toBeUndefined();
    expect(principalInHistory(history([[1, 40]]), 60)).toBeUndefined();
    // Held from 40, after the import's start: a change before it may be
    // missing, so 45 is unknown; from 50 on the change is inside the range.
    const later = history([[40, 200]]);
    expect(principalInHistory(later, 45)).toBeUndefined();
    expect(principalInHistory(later, 45, 20)).toBeUndefined();
    expect(principalInHistory(later, 60)).toBe(P2);
    // A gap between 20 and 60: 70 has no change in its range.
    // A feed held from 2 may lack a change at 1: unknown.
    expect(principalInHistory(history([[2, 200]]), 5)).toBeUndefined();
    const gap = history([
      [1, 20],
      [60, 200]
    ]);
    expect(principalInHistory(gap, 15)).toBe(P1);
    expect(principalInHistory(gap, 70)).toBeUndefined();
  });
});

describe('principalInHistory from the import', () => {
  // The feed is held from the import's start (40); the wallet is first
  // bound at 50: before that it was bound to none.
  const fromImport: ChainWalletHistory = {
    wallet: W,
    changes: [{ height: 50, principalId: P2 }],
    ranges: [[40, 200]],
    readHeight: 200
  };

  it('says bound to none before the first change when held from the import', () => {
    expect(principalInHistory(fromImport, 45, 40)).toBeNull();
    expect(principalInHistory(fromImport, 40, 40)).toBeNull();
    expect(principalInHistory(fromImport, 60, 40)).toBe(P2);
    // Held from before the import too.
    expect(principalInHistory(fromImport, 45, 41)).toBeNull();
  });

  it('cannot say without the import, or when the feed starts after it', () => {
    expect(principalInHistory(fromImport, 45)).toBeUndefined();
    expect(principalInHistory(fromImport, 45, 39)).toBeUndefined();
  });
});

describe('walletPrincipalAt', () => {
  it("says bound to none before a wallet's first change, held from the import", async () => {
    const { gateway, lookups } = setup(101, [[40, 200]]);
    gateway.getMembershipWalletHistory.mockResolvedValue({
      wallet: W,
      changes: [{ height: 500, principalId: P2 }],
      ranges: [[40, 600]],
      readHeight: 600
    });
    gateway.getMembership.mockResolvedValue({
      import: { completed: true, startHeight: 40 }
    });
    expect(await lookups.walletPrincipalAt(W, 300)).toBeNull();
    expect(await lookups.walletPrincipalAt(W, 500)).toBe(P2);
    // The import's start is read once.
    expect(gateway.getMembership).toHaveBeenCalledTimes(1);
  });

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
    expect(await lookups.walletPrincipalAt(W, 101)).toBe(P2);
    expect(gateway.getMembershipWalletHistory).toHaveBeenCalledTimes(3);
  });

  it('asks the chain when the bindings were read from another chain', async () => {
    const { gateway, lookups } = setup(101, [[1, 200]], '0x' + '33'.repeat(32));
    expect(await lookups.walletPrincipalAt(W, 60)).toBe(P2);
    expect(gateway.getMembershipWalletHistory).toHaveBeenCalledTimes(1);
    const noNetwork = setup(101, [[1, 200]], null);
    expect(await noNetwork.lookups.walletPrincipalAt(W, 60)).toBe(P2);
    expect(noNetwork.gateway.getMembershipWalletHistory).not.toHaveBeenCalled();
  });

  it('asks the chain before the first full sync', async () => {
    const { gateway, lookups } = setup(null);
    expect(await lookups.walletPrincipalAt(W, 60)).toBe(P2);
    expect(gateway.getMembershipWalletHistory).toHaveBeenCalledTimes(1);
  });

  it('throws when neither can say, never answering "bound to none"', async () => {
    const { lookups } = setup(101, [[40, 200]]);
    await expect(lookups.walletPrincipalAt(W, 45)).rejects.toBeInstanceOf(
      WalletPrincipalUnknownError
    );
    await expect(lookups.walletPrincipalAt(W, 250)).rejects.toBeInstanceOf(
      WalletPrincipalUnknownError
    );
  });

  it('refuses a height that is not one', async () => {
    const { lookups } = setup(101);
    for (const height of [Number.NaN, -1, 1.5]) {
      await expect(lookups.walletPrincipalAt(W, height)).rejects.toThrow(
        'Not a chain height'
      );
    }
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
