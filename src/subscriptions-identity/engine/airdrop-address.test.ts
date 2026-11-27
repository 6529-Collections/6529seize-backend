import {
  DELEGATION_ALL_ADDRESS,
  MEMES_CONTRACT,
  USE_CASE_AIRDROPS,
  USE_CASE_ALL,
  USE_CASE_MINTING
} from '@/constants';
import { DelegationRow, resolveAirdropTarget } from './airdrop-address';

const W1 = '0x0000000000000000000000000000000000000001';
const W2 = '0x0000000000000000000000000000000000000002';
const D1 = '0x00000000000000000000000000000000000000d1';
const D2 = '0x00000000000000000000000000000000000000d2';
const D3 = '0x00000000000000000000000000000000000000d3';
const NOW = 1_800_000_000;

function delegation(overrides: Partial<DelegationRow>): DelegationRow {
  return {
    fromAddress: W1,
    toAddress: D1,
    collection: MEMES_CONTRACT,
    useCase: USE_CASE_AIRDROPS,
    block: 100,
    expiry: NOW + 1000,
    allTokens: true,
    ...overrides
  };
}

function resolve(
  key: string,
  delegations: DelegationRow[],
  tdh: [string, number][] = []
) {
  return resolveAirdropTarget({
    key,
    delegations,
    boostedTdhByWallet: new Map(tdh),
    nowSeconds: NOW
  });
}

describe('resolveAirdropTarget', () => {
  it('uses the key itself for one wallet with no delegation', () => {
    expect(resolve(W1, [])).toEqual({
      airdropAddress: W1,
      tdhWallet: W1,
      ties: []
    });
  });

  it('uses the highest boosted TDH wallet of a group', () => {
    const result = resolve(
      `${W1}-${W2}`,
      [],
      [
        [W1, 10],
        [W2, 20]
      ]
    );
    expect(result.airdropAddress).toBe(W2);
    expect(resolve(`${W1}-${W2}`, []).airdropAddress).toBeNull();
  });

  it('reports a TDH tie and takes the lowest address', () => {
    const result = resolve(
      `${W1}-${W2}`,
      [],
      [
        [W1, 10],
        [W2, 10]
      ]
    );
    expect(result.airdropAddress).toBe(W1);
    expect(result.ties).toEqual(['TDH']);
  });

  it('prefers the most specific record per delegator', () => {
    const result = resolve(W1, [
      delegation({
        collection: DELEGATION_ALL_ADDRESS,
        toAddress: D2,
        block: 300
      }),
      delegation({ useCase: USE_CASE_ALL, toAddress: D3, block: 200 }),
      delegation({ toAddress: D1, block: 100 })
    ]);
    expect(result.airdropAddress).toBe(D1);
  });

  it('lets an expired specific record hide a live general one', () => {
    const result = resolve(W1, [
      delegation({ toAddress: D1, expiry: NOW - 1 }),
      delegation({ collection: DELEGATION_ALL_ADDRESS, toAddress: D2 })
    ]);
    expect(result.airdropAddress).toBe(W1);
  });

  it('takes the latest block across the group and ignores other use cases', () => {
    const result = resolve(`${W1}-${W2}`, [
      delegation({ fromAddress: W1, toAddress: D1, block: 100 }),
      delegation({ fromAddress: W2, toAddress: D2, block: 200 }),
      delegation({
        fromAddress: W2,
        toAddress: D3,
        block: 900,
        useCase: USE_CASE_MINTING
      })
    ]);
    expect(result.airdropAddress).toBe(D2);
  });

  it('resolves an identity key on the wallet list it is given', () => {
    const principal = `0x${'7'.repeat(64)}`;
    const one = resolveAirdropTarget({
      key: principal,
      wallets: [W1],
      delegations: [],
      boostedTdhByWallet: new Map(),
      nowSeconds: NOW
    });
    expect(one).toEqual({ airdropAddress: W1, tdhWallet: W1, ties: [] });
    const two = resolveAirdropTarget({
      key: principal,
      wallets: [W1, W2],
      delegations: [delegation({ fromAddress: W2, toAddress: D2 })],
      boostedTdhByWallet: new Map([[W1, 5]]),
      nowSeconds: NOW
    });
    expect(two).toEqual({ airdropAddress: D2, tdhWallet: W1, ties: [] });
  });

  it('ignores records for one token only', () => {
    const result = resolve(W1, [delegation({ allTokens: false })]);
    expect(result.airdropAddress).toBe(W1);
  });

  it('reports a block tie between delegators that changes the address', () => {
    const result = resolve(`${W1}-${W2}`, [
      delegation({ fromAddress: W1, toAddress: D2, block: 100 }),
      delegation({ fromAddress: W2, toAddress: D1, block: 100 })
    ]);
    expect(result.ties).toEqual(['DELEGATOR_BLOCK']);
    expect(result.airdropAddress).toBe(D2);
  });
});
