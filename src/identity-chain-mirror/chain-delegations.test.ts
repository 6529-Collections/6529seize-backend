import { ChainDelegation } from '@/chain-gateway/chain-gateway.types';
import {
  DELEGATION_ALL_ADDRESS,
  MEMES_CONTRACT,
  USE_CASE_AIRDROPS,
  USE_CASE_ALL,
  USE_CASE_MINTING
} from '@/constants';
import { ChainDelegations, resolveDelegations } from './chain-delegations';
import { DelegationRowWrite } from './delegation-rows';
import { CHAIN_BLOCK_BASE } from './identity-plan';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const MEMES = MEMES_CONTRACT.toLowerCase();
const NOW = 1_800_000_000;

function row(other: Partial<DelegationRowWrite>): DelegationRowWrite {
  return {
    block: 100,
    from_address: W(1),
    to_address: W(9),
    collection: MEMES,
    use_case: USE_CASE_MINTING,
    expiry: NOW + 1000,
    all_tokens: true,
    token_id: 0,
    ...other
  };
}

describe('resolveDelegations', () => {
  const resolve = (
    rows: DelegationRowWrite[],
    other: { tokenId?: number | null; wallets?: string[] } = {}
  ) =>
    resolveDelegations(rows, {
      collection: MEMES,
      useCase: USE_CASE_MINTING,
      nowSeconds: NOW,
      ...other
    }).map((it) => [it.from_address, it.to_address, it.block]);

  it('takes the most specific record per wallet, then the latest block', () => {
    expect(
      resolve([
        row({
          to_address: W(10),
          collection: DELEGATION_ALL_ADDRESS,
          block: 300
        }),
        row({ to_address: W(11), use_case: USE_CASE_ALL, block: 200 }),
        row({ to_address: W(12), block: 100 }),
        row({ to_address: W(13), block: 150 }),
        row({
          from_address: W(2),
          to_address: W(14),
          collection: DELEGATION_ALL_ADDRESS,
          use_case: USE_CASE_ALL,
          block: 50
        }),
        row({ from_address: W(3), use_case: USE_CASE_AIRDROPS, block: 400 })
      ])
    ).toEqual([
      [W(1), W(13), 150],
      [W(2), W(14), 50]
    ]);
  });

  it('counts a token-specific record only for its token', () => {
    const specific = row({
      to_address: W(20),
      all_tokens: false,
      token_id: 61,
      block: 500
    });
    const general = row({ to_address: W(21), block: 100 });
    expect(resolve([specific, general])).toEqual([[W(1), W(21), 100]]);
    expect(resolve([specific, general], { tokenId: 61 })).toEqual([
      [W(1), W(20), 500]
    ]);
    expect(resolve([specific, general], { tokenId: 62 })).toEqual([
      [W(1), W(21), 100]
    ]);
  });

  it('lets an expired specific record hide a live general one, as 6529.io does', () => {
    expect(
      resolve([
        row({ to_address: W(30), expiry: NOW - 1 }),
        row({ to_address: W(31), use_case: USE_CASE_ALL, block: 900 })
      ])
    ).toEqual([]);
  });

  it('keeps only the wallets asked for, after choosing', () => {
    expect(
      resolve([row({}), row({ from_address: W(2), to_address: W(40) })], {
        wallets: [W(2)]
      })
    ).toEqual([[W(2), W(40), 100]]);
  });

  it('ranks a record set on the chain above an imported one of the same kind', () => {
    expect(
      resolve([
        row({ to_address: W(50), block: 20_000_000 }),
        row({ to_address: W(51), block: CHAIN_BLOCK_BASE + 7 })
      ])
    ).toEqual([[W(1), W(51), CHAIN_BLOCK_BASE + 7]]);
  });
});

function record(
  holder: string,
  scope: 'wallet' | 'identity',
  other: Partial<ChainDelegation> = {}
): ChainDelegation {
  return {
    scope,
    holder,
    collection: MEMES,
    delegate: W(9),
    useCase: USE_CASE_MINTING,
    allTokens: true,
    tokenId: '0',
    expiry: '18446744073709551615',
    expired: false,
    source: 'set',
    setHeight: 40,
    ethBlock: null,
    logIndex: null,
    setBy: null,
    ...other
  };
}

describe('ChainDelegations', () => {
  const P = '0x' + 'ab'.repeat(32);
  function setup() {
    const gateway = {
      getHead: jest.fn(async () => ({
        headHeight: 102,
        finalizedHeight: 100,
        finalizedTime: 0,
        pinnable: null
      })),
      getDelegations: jest.fn(
        async (q: { byUseCase?: number }, _opts?: { height?: number }) => ({
          items:
            q.byUseCase === USE_CASE_MINTING
              ? [
                  record(P, 'identity'),
                  record(W(5), 'wallet', { delegate: W(6) })
                ]
              : [],
          next: null,
          read: {} as never
        })
      ),
      getDelegationsOfWallet: jest.fn(async (wallet: string) => [
        { scope: 'wallet' as const, holder: wallet, records: [], more: false },
        {
          scope: 'identity' as const,
          holder: P,
          records: [record(P, 'identity')],
          more: false
        }
      ]),
      getIdentityByPrincipal: jest.fn(async () => ({
        principalId: P,
        wallets: [W(1), W(2)]
      }))
    };
    return {
      gateway,
      delegations: new ChainDelegations(gateway as never, () => NOW * 1000)
    };
  }

  it('resolves every wallet at one height, an identity covering its wallets', async () => {
    const { delegations, gateway } = setup();
    const result = await delegations.processedDelegations(
      MEMES,
      USE_CASE_MINTING
    );
    expect(result.height).toBe(100);
    expect(
      result.rows.map((it) => [it.from_address, it.to_address]).sort()
    ).toEqual([
      [W(1), W(9)],
      [W(2), W(9)],
      [W(5), W(6)]
    ]);
    for (const call of gateway.getDelegations.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ height: 100 }));
    }
    expect(gateway.getIdentityByPrincipal).toHaveBeenCalledTimes(1);
  });

  it('resolves the asked wallets from their own and their identity records', async () => {
    const { delegations, gateway } = setup();
    const result = await delegations.processedDelegations(
      MEMES,
      USE_CASE_MINTING,
      [W(1)],
      null,
      77
    );
    expect(result.height).toBe(77);
    expect(result.rows).toEqual([
      expect.objectContaining({
        from_address: W(1),
        to_address: W(9),
        block: CHAIN_BLOCK_BASE + 40
      })
    ]);
    expect(gateway.getDelegationsOfWallet).toHaveBeenCalledWith(W(1), {
      height: 77
    });
    expect(gateway.getHead).not.toHaveBeenCalled();
  });
});
