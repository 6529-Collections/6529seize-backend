import {
  ChainIdentityLike,
  ChainRecordOwnerDirectory,
  ChainWalletHistoryLike
} from './record-owner-directory';

const PRINCIPAL = `0x${'0'.repeat(63)}1`;
const OTHER = `0x${'0'.repeat(63)}2`;
const BOUND = `0x${'1'.repeat(40)}`;
const SECOND = `0x${'2'.repeat(40)}`;
const UNBOUND = `0x${'3'.repeat(40)}`;

function setup(
  identity: ChainIdentityLike | null,
  histories: Record<string, ChainWalletHistoryLike> = {}
) {
  const profiles = new Map([
    [SECOND, 'p-second'],
    [UNBOUND, 'p-unbound']
  ]);
  const calls: string[] = [];
  const directory = new ChainRecordOwnerDirectory({
    getProfileIdByWallet: async (wallet) => profiles.get(wallet) ?? null
  });
  const chain = {
    getMembershipWalletHistory: async (wallet: string) => {
      calls.push(`history ${wallet}`);
      return histories[wallet] ?? null;
    },
    getIdentityByWallet: async (wallet: string, opts?: { height?: number }) => {
      calls.push(`wallet ${wallet}@${opts?.height}`);
      return identity && identity.wallets.includes(wallet) ? identity : null;
    },
    getIdentityByPrincipal: async (principal: string) => {
      calls.push(`principal ${principal}`);
      return identity?.principalId === principal ? identity : null;
    }
  };
  return { directory, chain, calls };
}

/** Bound to PRINCIPAL at 100, to OTHER at 200, unbound at 300. */
const MOVED: ChainWalletHistoryLike = {
  changes: [
    { height: 100, principalId: PRINCIPAL.toUpperCase().replace('0X', '0x') },
    { height: 200, principalId: OTHER },
    { height: 300, principalId: null }
  ],
  ranges: [[50, 400]],
  readHeight: 400
};

describe('ChainRecordOwnerDirectory', () => {
  it('treats every wallet as unbound until the gateway is wired in', async () => {
    const { directory } = setup(null);
    expect(directory.hasChain()).toBe(false);
    expect(await directory.principalAt(BOUND, 10)).toBeNull();
    expect(await directory.ownerAt(UNBOUND.toUpperCase(), 10)).toBe(UNBOUND);
    expect(await directory.profileIdOf(UNBOUND)).toBe('p-unbound');
    expect(await directory.profileIdOf(PRINCIPAL)).toBeNull();
  });

  it("reads a wallet's principal at a height from its binding history, once per height", async () => {
    const { directory, chain, calls } = setup(null, { [BOUND]: MOVED });
    directory.setChain(chain);
    expect(directory.hasChain()).toBe(true);
    expect(await directory.principalAt(BOUND, 99)).toBeNull();
    expect(await directory.principalAt(BOUND, 100)).toBe(PRINCIPAL);
    expect(await directory.principalAt(BOUND, 250)).toBe(OTHER);
    expect(await directory.ownerAt(BOUND, 350)).toBe(BOUND);
    expect(await directory.principalAt(BOUND, 100)).toBe(PRINCIPAL);
    // A wallet the history has never seen bound is unbound.
    expect(await directory.ownerAt(UNBOUND, 100)).toBe(UNBOUND);
    expect(calls.filter((call) => call.startsWith('history'))).toHaveLength(5);
  });

  it('refuses to answer for a height its history does not cover', async () => {
    const { directory, chain } = setup(null, { [BOUND]: MOVED });
    directory.setChain(chain);
    await expect(directory.principalAt(BOUND, 40)).rejects.toThrow(
      'does not cover height 40'
    );
    await expect(directory.principalAt(BOUND, 401)).rejects.toThrow(
      'does not cover height 401'
    );
  });

  it('maps a principal to the profile of one of its wallets', async () => {
    const { directory, chain } = setup({
      principalId: PRINCIPAL,
      wallets: [BOUND, SECOND]
    });
    directory.setChain(chain);
    expect(await directory.profileIdOf(PRINCIPAL)).toBe('p-second');
  });

  it("uses the identity's 6529.io profile id when the chain gives it", async () => {
    const { directory, chain } = setup({
      principalId: PRINCIPAL,
      wallets: [BOUND],
      legacyId: 'p-imported'
    });
    directory.setChain(chain);
    expect(await directory.profileIdOf(PRINCIPAL)).toBe('p-imported');
  });

  it("answers many wallets at a recent height in the client's batch read", async () => {
    const { directory, chain, calls } = setup(null);
    const batch = jest.fn(async () => ({
      [BOUND]: { principalId: PRINCIPAL, wallets: [BOUND] },
      [UNBOUND]: null
    }));
    directory.setChain({ ...chain, getIdentitiesByWallets: batch });
    const owners = await directory.ownersAt([BOUND, UNBOUND, BOUND], 500);
    expect(Array.from(owners.entries())).toEqual([
      [BOUND, PRINCIPAL],
      [UNBOUND, UNBOUND]
    ]);
    expect(batch).toHaveBeenCalledWith([BOUND, UNBOUND], { height: 500 });
    expect(calls).toEqual([]);
  });
});
