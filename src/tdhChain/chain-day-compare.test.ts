import {
  chainDayFixture,
  fixtureWallet,
  SiteFixture,
  siteFixture,
  siteUploadsCsv
} from '@/tests/fixtures/tdh-chain-day.fixture';
import {
  compareChainDay,
  CompareReport,
  DiffClass,
  summarizeReport
} from './chain-day-compare';
import { siteDayFromUploads } from './site-uploads';
import { TdhChainDay } from './tdh-chain.types';

const a = fixtureWallet('1');
const c = fixtureWallet('3');
const X = `${a}-${c}`;

function run(
  edit: (s: SiteFixture) => void = () => undefined,
  day: TdhChainDay = chainDayFixture()
): CompareReport {
  const site = siteFixture();
  edit(site);
  const { wallets, consolidated } = siteUploadsCsv(site);
  return compareChainDay(day, siteDayFromUploads(wallets, consolidated));
}

function nonzero(r: CompareReport): Partial<Record<DiffClass, number>> {
  return Object.fromEntries(
    Object.entries(r.counts).filter(([, n]) => n > 0)
  ) as Partial<Record<DiffClass, number>>;
}

function identity(s: SiteFixture, key: string) {
  return s.identities.find((i) => i.wallets.slice().sort().join('-') === key)!;
}

describe('compareChainDay', () => {
  it('matches P28 4.11 exactly, roots included', () => {
    const r = run();
    expect(nonzero(r)).toEqual({});
    expect(r.verdict).toBe('MATCH');
    expect(r.site.walletRootFromSite).toBe(r.chain.walletRoot);
    expect(r.site.tokenRootFromSite).toBe(r.chain.tokenRoot);
    expect(r.site.siteRowsWithoutLeaf).toBe(1);
    expect(r.site.walletsWithLeaf).toBe(5);
    expect(r.site.identitiesWithCluster).toBe(4);
    expect(r.site.totalTdh).toBe(1827);
  });

  it('compares wallets without a token list, and says so', () => {
    const r = run(undefined, { ...chainDayFixture(), tokenLeaves: null });
    expect(r.verdict).toBe('MATCH_WITHOUT_TOKENS');
    expect(r.site.tokenRootFromSite).toBeNull();
    expect(r.notes).toContain(
      'the chain side has no token list: per-card values not compared'
    );
  });

  it('finds a wallet value that differs', () => {
    const r = run((s) => {
      s.wallets[c] = { ...s.wallets[c], boostedTdh: 401 };
    });
    expect(nonzero(r)).toEqual({ WALLET_TDH: 1 });
    expect(r.differences.WALLET_TDH[0]).toEqual({
      subject: c,
      chain: 400,
      site: 401
    });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.site.walletRootFromSite).not.toBe(r.chain.walletRoot);
  });

  it('finds an identity value and the total that differ', () => {
    const r = run((s) => {
      identity(s, X).boostedTdh = 1501;
    });
    expect(nonzero(r)).toEqual({ IDENTITY_TDH: 1, TOTAL_TDH: 1 });
  });

  it('finds per-card values that differ, as Math.round of tdh times boost', () => {
    const r = run((s) => {
      const x = identity(s, X) as any;
      x.memes = [{ id: 1, balance: 2, tdh: 999 }];
    });
    expect(nonzero(r)).toEqual({ TOKEN_TDH: 1 });
    expect(r.differences.TOKEN_TDH[0].site).toBe(Math.round(999 * 1.25));
  });

  it('finds a token the site has and the chain does not', () => {
    const r = run((s) => {
      const b = identity(s, fixtureWallet('2')) as any;
      b.gradients = [{ id: 9, balance: 1, tdh: 3 }];
    });
    expect(nonzero(r)).toEqual({ TOKEN_EXTRA_ON_SITE: 1 });
  });

  it('finds wallets missing on the site, or extra there', () => {
    const missing = run((s) => {
      delete s.wallets[fixtureWallet('5')];
    });
    expect(nonzero(missing)).toEqual({
      WALLET_MISSING_ON_SITE: 1,
      WALLET_COUNT: 1,
      IDENTITY_COUNT: 1
    });
    const extra = run((s) => {
      s.wallets[fixtureWallet('7')] = {
        boostedTdh: 0,
        boost: 1,
        memes: [{ id: 4, balance: 1, tdh: 0 }]
      };
    });
    expect(nonzero(extra)).toEqual({
      WALLET_EXTRA_ON_SITE: 1,
      WALLET_COUNT: 1,
      IDENTITY_COUNT: 1
    });
  });

  it('finds a consolidation the site groups differently', () => {
    const r = run((s) => {
      s.identities = s.identities.filter((i) => !i.wallets.includes(a));
      s.identities.push({
        wallets: [a],
        boostedTdh: 1000,
        boost: 1.25,
        memes: [{ id: 1, balance: 1, tdh: 800 }]
      });
      s.identities.push({
        wallets: [c],
        boostedTdh: 500,
        boost: 1.1,
        memes: [{ id: 1, balance: 1, tdh: 200 }],
        gradients: [{ id: 5, balance: 1, tdh: 200 }]
      });
    });
    expect(r.counts.IDENTITY_MISSING_ON_SITE).toBe(1);
    expect(r.counts.WALLET_CLUSTER).toBe(2);
    expect(r.counts.IDENTITY_EXTRA_ON_SITE).toBe(2);
    expect(r.verdict).toBe('MISMATCH');
  });

  it('puts burn addresses the chain leaves out in their own class', () => {
    const zero = `0x${'0'.repeat(40)}`;
    const r = run((s) => {
      s.wallets[zero] = {
        boostedTdh: 500,
        boost: 1,
        memes: [{ id: 7, balance: 3, tdh: 500 }]
      };
      s.identities.push({
        wallets: [zero],
        boostedTdh: 500,
        boost: 1,
        memes: [{ id: 7, balance: 3, tdh: 500 }]
      });
    });
    expect(nonzero(r)).toEqual({
      BURN_MISSING_ON_CHAIN: 2,
      TOTAL_TDH: 1,
      IDENTITY_COUNT: 1,
      WALLET_COUNT: 1
    });
    expect(r.differences.BURN_MISSING_ON_CHAIN[0]).toEqual({
      subject: zero,
      chain: null,
      site: 500
    });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.notes).toContain(
      'the burn addresses missing on the chain (1 wallets, 500 TDH) are exactly the differences in TOTAL_TDH, IDENTITY_COUNT and WALLET_COUNT'
    );
  });

  it('finds another block or date', () => {
    const r = run((s) => {
      (s as any).block = s.block + 1;
    });
    expect(nonzero(r)).toEqual({ BLOCK: 1 });
  });

  it('is a mismatch when the chain day fails its own checks', () => {
    const day = chainDayFixture();
    const r = run(undefined, {
      ...day,
      header: { ...day.header, totalTdh: 1 }
    });
    expect(r.chain.verified).toBe(false);
    expect(r.verdict).toBe('MISMATCH');
  });

  it('caps the kept differences but not the counts', () => {
    const site = siteFixture();
    for (let i = 0; i < 30; i++) {
      site.wallets[`0x${(0xa0 + i).toString(16)}${'0'.repeat(38)}`] = {
        boostedTdh: 1,
        boost: 1
      };
    }
    const { wallets, consolidated } = siteUploadsCsv(site);
    const r = compareChainDay(
      chainDayFixture(),
      siteDayFromUploads(wallets, consolidated),
      { keepPerClass: 10 }
    );
    expect(r.counts.WALLET_EXTRA_ON_SITE).toBe(30);
    expect(r.differences.WALLET_EXTRA_ON_SITE).toHaveLength(10);
  });

  it('summarizes in about ten lines', () => {
    const text = summarizeReport(run());
    expect(text.split('\n').length).toBeLessThanOrEqual(12);
    expect(text).toContain('TDH day 20261011 (cycle day 20737): MATCH');
    expect(text).toContain('differences: none');
  });
});
