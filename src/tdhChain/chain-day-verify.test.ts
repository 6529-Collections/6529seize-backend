import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import {
  ChainDayCheck,
  verifyChainDay,
  verifyCutoff
} from './chain-day-verify';
import { tokenRoot, walletRoot } from './p28';
import { TdhChainDay, TdhTokenLeaf, TdhWalletLeaf } from './tdh-chain.types';

function checks(day: TdhChainDay): ChainDayCheck[] {
  return Array.from(new Set(verifyChainDay(day).failures.map((f) => f.check)));
}

/** A day whose lists changed and whose header's roots and counts follow. */
function resealed(
  walletLeaves: TdhWalletLeaf[],
  tokenLeaves: TdhTokenLeaf[] | null = chainDayFixture().tokenLeaves!.slice()
): TdhChainDay {
  const day = chainDayFixture();
  return {
    ...day,
    header: {
      ...day.header,
      walletRoot: walletRoot(walletLeaves),
      walletCount: walletLeaves.length,
      tokenRoot: tokenLeaves ? tokenRoot(tokenLeaves) : day.header.tokenRoot,
      tokenCount: tokenLeaves ? tokenLeaves.length : day.header.tokenCount
    },
    walletLeaves,
    tokenLeaves
  };
}

describe('verifyChainDay', () => {
  it('accepts P28 4.11 and returns its clusters', () => {
    const v = verifyChainDay(chainDayFixture());
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.clusters.size).toBe(4);
    const x = v.clusters.get(chainDayFixture().walletLeaves[0].cid)!;
    expect(x.wallets).toEqual([`0x${'1'.repeat(40)}`, `0x${'3'.repeat(40)}`]);
    expect(x.key).toBe(`0x${'1'.repeat(40)}-0x${'3'.repeat(40)}`);
    expect(x.identityTdh).toBe(1500);
  });

  it('accepts a day without a token list', () => {
    expect(verifyChainDay({ ...chainDayFixture(), tokenLeaves: null }).ok).toBe(
      true
    );
  });

  it('checks the header against the lists', () => {
    const day = chainDayFixture();
    expect(
      checks({ ...day, header: { ...day.header, walletCount: 6 } })
    ).toEqual(['WALLET_COUNT']);
    expect(
      checks({
        ...day,
        header: { ...day.header, walletRoot: day.header.tokenRoot }
      })
    ).toEqual(['WALLET_ROOT']);
    expect(
      checks({ ...day, header: { ...day.header, totalTdh: 1828 } })
    ).toEqual(['TOTAL_TDH']);
    expect(
      checks({ ...day, header: { ...day.header, identityCount: 5 } })
    ).toEqual(['IDENTITY_COUNT']);
    expect(
      checks({
        ...day,
        header: { ...day.header, boundary: day.header.boundary + 1 }
      })
    ).toEqual(['BOUNDARY']);
    expect(
      checks({ ...day, header: { ...day.header, tokenCount: 3 } })
    ).toEqual(['TOKEN_COUNT']);
    expect(
      checks({
        ...day,
        header: { ...day.header, tokenRoot: day.header.walletRoot }
      })
    ).toEqual(['TOKEN_ROOT']);
  });

  it('checks order and clusters even when the roots are resealed', () => {
    const leaves = chainDayFixture().walletLeaves.slice();
    expect(
      checks(resealed([leaves[1], leaves[0], ...leaves.slice(2)]))
    ).toEqual(['WALLET_ORDER']);
    const wrongCount = leaves.map((l, i) =>
      i === 0 ? { ...l, walletCount: 3 } : l
    );
    expect(checks(resealed(wrongCount))).toEqual([
      'CLUSTER_CONSISTENT',
      'CLUSTER_SIZE'
    ]);
    const wrongTdh = leaves.map((l, i) =>
      i === 2 ? { ...l, identityTdh: 1499 } : l
    );
    expect(checks(resealed(wrongTdh))).toContain('CLUSTER_CONSISTENT');
    const wrongCid = leaves
      .map((l, i) =>
        i === 1 ? { ...l, cid: leaves[3].cid, walletCount: 2 } : l
      )
      .map((l, i) => (i === 3 ? { ...l, walletCount: 2 } : l));
    expect(checks(resealed(wrongCid))).toEqual(
      expect.arrayContaining(['CLUSTER_CID'])
    );
  });

  it('checks the token list', () => {
    const tokens = chainDayFixture().tokenLeaves!.slice();
    expect(
      checks(
        resealed(chainDayFixture().walletLeaves.slice(), [
          tokens[1],
          tokens[0],
          tokens[2],
          tokens[3]
        ])
      )
    ).toEqual(['TOKEN_ORDER']);
    const orphan = { ...tokens[3], cid: `0x${'f'.repeat(64)}` };
    expect(
      checks(
        resealed(chainDayFixture().walletLeaves.slice(), [
          ...tokens.slice(0, 3),
          orphan
        ])
      )
    ).toEqual(['TOKEN_CID']);
    const zero = { ...tokens[3], tokenTdh: 0 };
    expect(
      checks(
        resealed(chainDayFixture().walletLeaves.slice(), [
          ...tokens.slice(0, 3),
          zero
        ])
      )
    ).toEqual(['TOKEN_ZERO']);
  });

  it('keeps at most twenty details a check', () => {
    const many = Array.from({ length: 40 }, (_, i) => {
      const hex = BigInt(1000 - i)
        .toString(16)
        .padStart(40, '0');
      return {
        wallet: `0x${hex}`,
        cid: `0x${'0'.repeat(64)}`,
        identityTdh: 0,
        walletTdh: 0,
        walletCount: 1
      };
    });
    const v = verifyChainDay(resealed(many, null));
    expect(v.failures.filter((f) => f.check === 'WALLET_ORDER')).toHaveLength(
      21
    );
  });
});

describe('verifyCutoff', () => {
  const header = chainDayFixture().header;
  const reader = (hash: string, time: number, nextTime: number) => ({
    getBlock: async (n: number) =>
      n === header.cutoffNumber
        ? { hash, timestamp: time }
        : { hash: '0x00', timestamp: nextTime }
  });

  it('accepts the last block before the boundary', async () => {
    expect(
      await verifyCutoff(
        header,
        reader(header.cutoffHash, header.cutoffTimestamp, header.boundary + 11)
      )
    ).toEqual([]);
    expect(
      await verifyCutoff(
        header,
        reader(
          header.cutoffHash.toUpperCase().replace('0X', '0x'),
          header.cutoffTimestamp,
          header.boundary
        )
      )
    ).toEqual([]);
  });

  it('refuses another hash, time or a block that is not the last', async () => {
    expect(
      await verifyCutoff(
        header,
        reader(`0x${'0'.repeat(64)}`, header.cutoffTimestamp, header.boundary)
      )
    ).toHaveLength(1);
    expect(
      await verifyCutoff(
        header,
        reader(header.cutoffHash, header.cutoffTimestamp - 1, header.boundary)
      )
    ).toHaveLength(1);
    expect(
      await verifyCutoff(
        header,
        reader(header.cutoffHash, header.cutoffTimestamp, header.boundary - 1)
      )
    ).toHaveLength(1);
  });
});
