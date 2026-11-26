import {
  FIXTURE_BLOCK,
  FIXTURE_DATE,
  fixtureWallet,
  siteFixture,
  siteUploadsCsv
} from '@/tests/fixtures/tdh-chain-day.fixture';
import { parseCsv } from './csv';
import { cycleDayOfDate, dateOfCycleDay, SiteDayError } from './site-day';
import { siteDayFromUploads } from './site-uploads';

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes and both line endings', () => {
    expect(parseCsv('a,"b,c","d""e"\r\n1,,"x\ny"\n')).toEqual([
      ['a', 'b,c', 'd"e'],
      ['1', '', 'x\ny']
    ]);
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
    expect(parseCsv('a,\n')).toEqual([['a', '']]);
  });

  it('refuses stray quotes, unclosed quotes and empty records', () => {
    for (const bad of ['a"b\n', '"a"b\n', '"a\n', 'a\n\nb\n', 'a\rb\n']) {
      expect(() => parseCsv(bad)).toThrow();
    }
  });
});

describe('site day dates', () => {
  it('maps cycle days and dates both ways', () => {
    expect(dateOfCycleDay(20737)).toBe('20261011');
    expect(dateOfCycleDay(20781)).toBe('20261124');
    expect(cycleDayOfDate('20261124')).toBe(20781);
    expect(() => cycleDayOfDate('20261131')).toThrow();
  });
});

describe('siteDayFromUploads', () => {
  it('reads both uploads of the fixture', () => {
    const { wallets, consolidated } = siteUploadsCsv();
    const day = siteDayFromUploads(wallets, consolidated);
    expect(day.block).toBe(FIXTURE_BLOCK);
    expect(day.date).toBe(FIXTURE_DATE);
    expect(day.wallets.size).toBe(6);
    expect(day.identities.size).toBe(5);
    expect(day.wallets.get(fixtureWallet('4'))).toEqual({
      wallet: fixtureWallet('4'),
      boostedTdh: 0,
      holds: true
    });
    expect(day.wallets.get(fixtureWallet('6'))!.holds).toBe(false);
    const x = day.identities.get(
      `${fixtureWallet('1')}-${fixtureWallet('3')}`
    )!;
    expect(x.boost).toBe(1.25);
    expect(x.tokens).toEqual([
      { collection: 'memes', tokenId: '1', tdh: 1000, balance: 2 },
      { collection: 'gradients', tokenId: '5', tdh: 200, balance: 1 }
    ]);
    expect(day.notes).toEqual([]);
  });

  it('never reads the display column and notes columns it does not know', () => {
    const { wallets, consolidated } = siteUploadsCsv();
    const w2 = fixtureWallet('2');
    const named = consolidated.replace(
      `${w2},${w2},`,
      `${w2},"a name, ""quoted""",`
    );
    expect(named).not.toBe(consolidated);
    // A new column on the header row (the first line) and on every row.
    const extra = wallets
      .replace(/^([^\n]*)\n/, '$1,new_column\n')
      .replace(/\n(0x[^\n]+)/g, '\n$1,7');
    const day = siteDayFromUploads(extra, named);
    expect(day.notes).toEqual([
      'wallet upload: columns not in the 2026-10-14 layout: new_column'
    ]);
  });

  it('refuses rows it cannot trust', () => {
    const site = siteFixture();
    const ok = siteUploadsCsv(site);
    const cases: [string, string][] = [
      [ok.wallets.replace('boosted_tdh,', 'boosted_tdhx,'), ok.consolidated],
      [ok.wallets.replace(',1000,', ',1000.5,'), ok.consolidated],
      [ok.wallets + ok.wallets.split('\n')[1] + '\n', ok.consolidated],
      [
        ok.wallets,
        ok.consolidated.replace(
          `${FIXTURE_BLOCK},${FIXTURE_DATE}`,
          `${FIXTURE_BLOCK + 1},${FIXTURE_DATE}`
        )
      ],
      [
        ok.wallets,
        ok.consolidated.replace(
          `[""${fixtureWallet('2')}""]`,
          `[""${fixtureWallet('1')}""]`
        )
      ],
      [ok.wallets, ok.consolidated.replace('1.25', '1.250')]
    ];
    for (const [w, c] of cases) {
      expect(() => siteDayFromUploads(w, c)).toThrow(SiteDayError);
    }
  });
});
