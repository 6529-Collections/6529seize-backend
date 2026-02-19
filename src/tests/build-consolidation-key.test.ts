import { consolidationTools } from '@/consolidation-tools';

describe('consolidationTools.buildConsolidationKey – deterministic matrix', () => {
  it.each([
    [['0xDef', '0xabc', '0x123'], '0x123-0xabc-0xdef'],
    [['0x1', '0x2', '0x3'], '0x1-0x2-0x3'],
    [['0xABC', '0xabc'], '0xabc-0xabc'], // duplicates kept
    [['0x1'], '0x1'],
    [[], ''],
    [['hello', 'World', '1'], '1-hello-world']
  ])(
    'consolidationTools.buildConsolidationKey(%j) → %s',
    (input: string[], expected: string) => {
      expect(consolidationTools.buildConsolidationKey([...input])).toBe(
        expected
      );
    }
  );

  it('single element has no hyphen', () => {
    const out = consolidationTools.buildConsolidationKey(['0x1']);
    expect(out).toBe('0x1');
    expect(out.includes('-')).toBe(false);
  });
});

describe('consolidationTools.buildConsolidationKey – other behaviors', () => {
  it('original input array is not mutated', () => {
    const input = ['0xB', '0xA'];
    const copy = [...input];
    consolidationTools.buildConsolidationKey(input);
    expect(input).toEqual(copy);
  });

  it('undefined or null throws TypeError', () => {
    expect(() =>
      consolidationTools.buildConsolidationKey(undefined as any)
    ).toThrow(TypeError);
    expect(() => consolidationTools.buildConsolidationKey(null as any)).toThrow(
      TypeError
    );
  });
});

describe('consolidationTools.buildConsolidationKey – performance', () => {
  it('handles very large inputs', () => {
    const bigArr = Array.from({ length: 100000 }, (_, i) => `0x${i}`);
    expect(() =>
      consolidationTools.buildConsolidationKey(bigArr)
    ).not.toThrow();
  });
});

/*describe('sd', () => {
  it('daas', async () => {
    const urls = [
      //'https://manifold.xyz/@andrew-hooker/id/4098474224'
      //'https://www.transient.xyz/mint/duetumaeternum'
      //'https://www.transient.xyz/nfts/ethereum/0x5fb8afd38172d6802de095c09714066c97310adf/7' // works
      'https://www.transient.xyz/mint/paulatim-deinde-subito' // works
      //'https://foundation.app/mint/eth/0xda6791077610D97618D2F3fB489bfd3151784aCF/2', // LISTED 0.25 / ETH / works
      //'https://superrare.com/artwork/eth/0x961Af8Be78947928443b14eB86f18cE46E5C6ddC/6' // LISTED / 1.5 / ETH
      //'https://opensea.io/item/ethereum/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1013', // FIXED / 7750000000000000000 / ETH
      //'https://opensea.io/assets/ethereum/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1014' // FIXED / 7750000000000000000 / ETH
    ];
    for (const url of urls) {
      const start = Time.now();
      const resp = await nftLinkResolver.resolve(url, {});
      const took = start.diffFromNow();
      console.log(`${url} took ${took}`, JSON.stringify(resp, null, 2));
    }
  });
});*/
