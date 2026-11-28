import { AbiCoder, getBytes, hexlify, keccak256, toUtf8Bytes } from 'ethers';
import fc from 'fast-check';
import {
  cidOf,
  consolidationKeyOf,
  merkleNode,
  merkleTop,
  tokenLeafHash,
  tokenRoot,
  verifyPath,
  walletLeafHash,
  walletRoot,
  walletsOfConsolidationKey
} from './p28';
import { TdhWalletLeaf } from './tdh-chain.types';

const w = (digit: string) => `0x${digit.repeat(40)}`;

// P28 4.11: five wallets on cycle day 20737. 0x11..11 and 0x33..33 form
// consolidation X, whose identity TDH exceeds their own sum.
const X = '0xcdee55c0e111c2a4cc7cad2d3f9f65f752f4a6c36082f45e258638ba5dd0afcb';
const VECTOR: TdhWalletLeaf[] = [
  {
    wallet: w('1'),
    cid: X,
    identityTdh: 1500,
    walletTdh: 1000,
    walletCount: 2
  },
  {
    wallet: w('2'),
    cid: '0x8fc6d9e3416c326a713c42349054a4e77b0273481ed91688b4cc78ff9c55fdbe',
    identityTdh: 250,
    walletTdh: 250,
    walletCount: 1
  },
  { wallet: w('3'), cid: X, identityTdh: 1500, walletTdh: 400, walletCount: 2 },
  {
    wallet: w('4'),
    cid: '0x8fd288634907f377c5948d76373b1ce54dd86e532f6c75132f9bea1eb9af0788',
    identityTdh: 0,
    walletTdh: 0,
    walletCount: 1
  },
  {
    wallet: w('5'),
    cid: '0xd2efc0371dd92f5829ffe60ac44ad0bece2bf56b3eb1c5f660fa07949eaec6e1',
    identityTdh: 77,
    walletTdh: 77,
    walletCount: 1
  }
];

describe('P28 TDH commitments', () => {
  it('computes the cids of P28 4.11', () => {
    expect(cidOf([w('1'), w('3')])).toBe(X);
    expect(cidOf([w('2')])).toBe(VECTOR[1].cid);
    expect(cidOf([w('4')])).toBe(VECTOR[3].cid);
    expect(cidOf([w('5')])).toBe(VECTOR[4].cid);
  });

  it('refuses unsorted, repeated or empty cid wallets', () => {
    expect(() => cidOf([w('3'), w('1')])).toThrow();
    expect(() => cidOf([w('1'), w('1')])).toThrow();
    expect(() => cidOf([])).toThrow();
    expect(() => cidOf(['0x' + 'A'.repeat(40)])).toThrow();
  });

  it('computes the leaves, top and roots of P28 4.11', () => {
    const leaves = VECTOR.map(walletLeafHash);
    expect(hexlify(leaves[0])).toBe(
      '0x005264c8752c7274f89dd66a99cd739157773a98d3efcd2cb25fddb56f00f2b3'
    );
    expect(hexlify(leaves[1])).toBe(
      '0x6654f70f47cb662d8e7564f16d23e50b3227cad7481c505462d9d8a77f8809e1'
    );
    expect(hexlify(leaves[2])).toBe(
      '0x76471551fdae3278e713848a7b327b4bb06b3ae9aebd2ed0287d250f3db111a1'
    );
    expect(hexlify(leaves[3])).toBe(
      '0x67f4e0ff443258a34a09db2657838f172168cad45195e03aad48273ef46e874b'
    );
    expect(hexlify(leaves[4])).toBe(
      '0xf81ac8ff2dcc842a7eb5dcce1d7666c5baed3041baba55a2822f23bdccb0c94f'
    );
    expect(hexlify(merkleNode(leaves[0], leaves[1]))).toBe(
      '0x31e396e1440a58c45844c56e5ca67629b33b606c318f95ed46600ce0d458a02d'
    );
    expect(hexlify(merkleTop(leaves))).toBe(
      '0x21fdd4b984cf0643cc2099d912fd866feefc40f4d973fc0184302022c60c6bb0'
    );
    expect(walletRoot(VECTOR)).toBe(
      '0x0e83847e3e2988382cfeea799feb510e088af122c8978ade3b19da2a287b9ac9'
    );
    expect(walletRoot(VECTOR.slice(0, 1))).toBe(
      '0x8c1f0c3a6b7375da3fec06336de8e8c7b0be10596675696940e1ed25ee88d9df'
    );
    expect(walletRoot([])).toBe(
      '0x050255c7eaea8b83a08b806d8e0bb60f8f05789acfa7a6f30d67be6721376899'
    );
  });

  it('verifies the proofs of P28 4.11', () => {
    const leaves = VECTOR.map(walletLeafHash);
    const top = merkleTop(leaves);
    const n0123 = merkleNode(
      merkleNode(leaves[0], leaves[1]),
      merkleNode(leaves[2], leaves[3])
    );
    expect(
      verifyPath(
        leaves[2],
        2,
        5,
        [leaves[3], merkleNode(leaves[0], leaves[1]), leaves[4]],
        top
      )
    ).toBe(true);
    expect(verifyPath(leaves[4], 4, 5, [n0123], top)).toBe(true);
    expect(verifyPath(leaves[4], 4, 6, [n0123], top)).toBe(false);
    expect(verifyPath(leaves[1], 2, 5, [leaves[3]], top)).toBe(false);
  });

  it('hashes leaves as abi.encode does', () => {
    const coder = AbiCoder.defaultAbiCoder();
    const tagOf = (name: string) => keccak256(toUtf8Bytes(name));
    const leaf = VECTOR[2];
    expect(hexlify(walletLeafHash(leaf))).toBe(
      keccak256(
        coder.encode(
          ['bytes32', 'address', 'bytes32', 'uint64', 'uint64', 'uint8'],
          [
            tagOf('6529.TdhWalletLeaf.v1'),
            leaf.wallet,
            leaf.cid,
            leaf.identityTdh,
            leaf.walletTdh,
            leaf.walletCount
          ]
        )
      )
    );
    const token = {
      cid: X,
      contract: '0x' + 'ab'.repeat(20),
      tokenId: '10000000013',
      tokenTdh: 4321
    };
    expect(hexlify(tokenLeafHash(token))).toBe(
      keccak256(
        coder.encode(
          ['bytes32', 'bytes32', 'address', 'uint256', 'uint64'],
          [
            tagOf('6529.TdhTokenLeaf.v1'),
            token.cid,
            token.contract,
            token.tokenId,
            token.tokenTdh
          ]
        )
      )
    );
    expect(cidOf([w('1'), w('3')])).toBe(
      keccak256(
        coder.encode(
          ['bytes32', 'address[]'],
          [tagOf('6529.TdhIdentity.v1'), [w('1'), w('3')]]
        )
      )
    );
    expect(tokenRoot([token])).toBe(
      keccak256(
        coder.encode(
          ['bytes32', 'uint64', 'bytes32'],
          [tagOf('6529.TdhTokenRoot.v1'), 1, tokenLeafHash(token)]
        )
      )
    );
  });

  it('gives the token leaves and roots computed from the spec text', () => {
    // Computed with ethers alone from the gateway's spec: leaf =
    // H("6529.TdhTokenLeaf.v1", bytes32 cid, address contract, uint256
    // tokenId, uint tokenTDH); root = H("6529.TdhTokenRoot.v1", count, top),
    // with P28 4.4's tree. The second id is 2^130 + 5, past 128 bits.
    const A = `0x${'11'.repeat(32)}`;
    const B = `0x${'22'.repeat(32)}`;
    const memes = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
    const gradients = '0x0c58ef43ff3032005e472cb5709f8908acb00205';
    const tokens = [
      { cid: A, contract: gradients, tokenId: '7', tokenTdh: 1500 },
      {
        cid: A,
        contract: memes,
        tokenId: '1361129467683753853853498429727072845829',
        tokenTdh: 42
      },
      { cid: B, contract: memes, tokenId: '1', tokenTdh: 987654321 }
    ];
    expect(tokens.map((t) => hexlify(tokenLeafHash(t)))).toEqual([
      '0x5bffb79d43734409dd22c8272fc1b01e47740d3dd84702ce327c46feaf46c118',
      '0xb0c34c0ffc82738eff3c0edb9dd49be734d1d78fbdf2c7315b9f8f9725f4b8b0',
      '0xef5775e393a9629f1c7daf77b5609b80835e1ff1e1777f46b186f9b29393fe0d'
    ]);
    expect(tokenRoot(tokens)).toBe(
      '0x253c94884316737a996053f3fc08f6405eb499082ff42eeeca2a62cc3d80e439'
    );
    expect(tokenRoot([tokens[1]])).toBe(
      '0xcc078d16be27d6068b0611d862e53328c6ba81c8643a25aed7bf0bdd57577a99'
    );
  });

  it('keys consolidations with the same wallets and order as the cid', () => {
    const mixed = consolidationKeyOf([`0x${'A'.repeat(40)}`, w('1')]);
    expect(mixed).toBe(`${w('1')}-0x${'a'.repeat(40)}`);
    const key = consolidationKeyOf([w('3'), w('1')]);
    expect(key).toBe(`${w('1')}-${w('3')}`);
    expect(cidOf(walletsOfConsolidationKey(key))).toBe(X);
  });

  it('builds a list top from chunk tops of a power-of-two size', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 70 }),
        fc.constantFrom(1, 2, 4, 8, 16),
        (n, size) => {
          const leaves = Array.from({ length: n }, (_, i) =>
            getBytes(keccak256(toUtf8Bytes(`leaf ${i}`)))
          );
          const chunkTops: Uint8Array[] = [];
          for (let i = 0; i < n; i += size) {
            chunkTops.push(merkleTop(leaves.slice(i, i + size)));
          }
          return hexlify(merkleTop(chunkTops)) === hexlify(merkleTop(leaves));
        }
      ),
      { numRuns: 60 }
    );
  });
});
