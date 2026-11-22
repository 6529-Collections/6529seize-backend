import { ChainFeedBlock } from '@/chain-gateway/chain-gateway.types';
import {
  bindingChangesOf,
  foldBindings,
  WalletBindingRow
} from './wallet-bindings';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const P = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function block(
  height: number,
  records: ChainFeedBlock['records']
): ChainFeedBlock {
  return { height, slot: height, root: '0x', time: height * 1000, records };
}

function binding(wallet: string, principal: string | null) {
  return {
    family: '0x0102',
    name: 'AddressBinding',
    key: '0x',
    value: principal === null ? null : '0x01',
    keyFields: { address: wallet.toUpperCase().replace('0X', '0x') },
    valueFields: principal === null ? null : { principalId: principal }
  };
}

describe('bindingChangesOf', () => {
  it('reads AddressBinding writes and deletes in block order', () => {
    expect(
      bindingChangesOf([
        block(3, [
          binding(W(1), P(1)),
          { family: '0x0104', name: 'Profile', key: '0x', value: '0x' }
        ]),
        block(5, [
          binding(W(1), null),
          { ...binding(W(3), P(2)), valueFields: { principalId: '0x1' } },
          { ...binding(W(4), P(2)), name: 'Renamed' }
        ])
      ])
    ).toEqual({
      changes: [
        { wallet: W(1), principalId: P(1), height: 3 },
        { wallet: W(1), principalId: null, height: 5 },
        // A write whose principal can't be read drops the row.
        { wallet: W(3), principalId: null, height: 5 },
        { wallet: W(4), principalId: P(2), height: 5 }
      ],
      malformed: ['5:0x'],
      stoppedAt: null
    });
  });

  it('stops before a block with a wallet it cannot read', () => {
    expect(
      bindingChangesOf([
        block(3, [binding(W(1), P(1))]),
        block(5, [binding(W(2), P(1)), binding('0x12', P(2))]),
        block(9, [binding(W(3), P(2))])
      ])
    ).toEqual({
      changes: [{ wallet: W(1), principalId: P(1), height: 3 }],
      malformed: ['5:0x'],
      stoppedAt: 5
    });
  });
});

describe('foldBindings', () => {
  const row = (wallet: string, principal: string, height: number) => ({
    wallet,
    principal_id: principal,
    bound_from_height: height
  });
  const stored = new Map<string, WalletBindingRow>([
    [W(1), row(W(1), P(1), 3)],
    [W(2), row(W(2), P(1), 3)]
  ]);

  it('starts a new height on a move and keeps it on a rewrite', () => {
    expect(
      foldBindings(stored, [
        { wallet: W(1), principalId: P(1), height: 8 },
        { wallet: W(2), principalId: P(2), height: 9 },
        { wallet: W(3), principalId: P(2), height: 9 }
      ])
    ).toEqual({
      upserts: [row(W(2), P(2), 9), row(W(3), P(2), 9)],
      deletes: []
    });
  });

  it('removes an unbound wallet and restarts one bound again', () => {
    expect(
      foldBindings(stored, [
        { wallet: W(1), principalId: null, height: 8 },
        { wallet: W(2), principalId: null, height: 8 },
        { wallet: W(2), principalId: P(1), height: 12 },
        { wallet: W(4), principalId: null, height: 12 }
      ])
    ).toEqual({ upserts: [row(W(2), P(1), 12)], deletes: [W(1)] });
  });
});
