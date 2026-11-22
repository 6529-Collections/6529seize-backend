import {
  ChainIdentityLike,
  ChainRecordOwnerDirectory
} from './record-owner-directory';

const PRINCIPAL = `0x${'0'.repeat(63)}1`;
const BOUND = `0x${'1'.repeat(40)}`;
const SECOND = `0x${'2'.repeat(40)}`;
const UNBOUND = `0x${'3'.repeat(40)}`;

function setup(identity: ChainIdentityLike | null) {
  const profiles = new Map([
    [SECOND, 'p-second'],
    [UNBOUND, 'p-unbound']
  ]);
  const calls: string[] = [];
  const directory = new ChainRecordOwnerDirectory({
    getProfileIdByWallet: async (wallet) => profiles.get(wallet) ?? null
  });
  const chain = {
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

describe('ChainRecordOwnerDirectory', () => {
  it('treats every wallet as unbound until the gateway is wired in', async () => {
    const { directory } = setup(null);
    expect(await directory.principalAt(BOUND, 10)).toBeNull();
    expect(await directory.ownerAt(UNBOUND.toUpperCase(), 10)).toBe(UNBOUND);
    expect(await directory.profileIdOf(UNBOUND)).toBe('p-unbound');
    expect(await directory.profileIdOf(PRINCIPAL)).toBeNull();
  });

  it('reads bindings at a height once, and maps a principal to the profile of one of its wallets', async () => {
    const { directory, chain, calls } = setup({
      principalId: PRINCIPAL,
      wallets: [BOUND, SECOND]
    });
    directory.setChain(chain);
    expect(await directory.principalAt(BOUND, 10)).toBe(PRINCIPAL);
    expect(await directory.ownerAt(BOUND, 10)).toBe(PRINCIPAL);
    expect(await directory.ownerAt(UNBOUND, 10)).toBe(UNBOUND);
    expect(calls.filter((call) => call.startsWith('wallet'))).toEqual([
      `wallet ${BOUND}@10`,
      `wallet ${UNBOUND}@10`
    ]);
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
});
