import { chainDayFixture } from '@/tests/fixtures/tdh-chain-day.fixture';
import {
  formatTokenDayFile,
  formatWalletDayFile,
  parseDayFiles,
  TdhDayFileError
} from './tdh-day-file';

describe('TDH day files', () => {
  it('round-trips a day through its two files', () => {
    const day = chainDayFixture();
    const wallets = formatWalletDayFile(day);
    const tokens = formatTokenDayFile(day);
    expect(parseDayFiles(wallets, tokens)).toEqual(day);
    expect(parseDayFiles(wallets, null)).toEqual({ ...day, tokenLeaves: null });
  });

  it('writes the same bytes for the same day', () => {
    expect(formatWalletDayFile(chainDayFixture())).toBe(
      formatWalletDayFile(chainDayFixture())
    );
    const text = formatWalletDayFile(chainDayFixture());
    expect(text).toContain('# cycle_day: 20737\n');
    expect(text).toContain(
      '# wallet_root: 0x0e83847e3e2988382cfeea799feb510e088af122c8978ade3b19da2a287b9ac9\n'
    );
    expect(text).toContain(
      `0x${'1'.repeat(40)},0xcdee55c0e111c2a4cc7cad2d3f9f65f752f4a6c36082f45e258638ba5dd0afcb,1500,1000,2,0x${'1'.repeat(40)}-0x${'3'.repeat(40)}\n`
    );
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
  });

  it('leaves out apply fields it does not know', () => {
    const day = {
      ...chainDayFixture(),
      apply: {
        applyHeight: null,
        applyBlockHash: null,
        applyTimeMs: null,
        finalizedHeight: null
      }
    };
    const text = formatWalletDayFile(day);
    expect(text).not.toContain('apply_height');
    expect(parseDayFiles(text, null).apply.applyHeight).toBeNull();
  });

  it('refuses what it cannot read exactly', () => {
    const day = chainDayFixture();
    const wallets = formatWalletDayFile(day);
    const tokens = formatTokenDayFile(day);
    const cases: [string, string | null][] = [
      [wallets.replace('# total_tdh: 1827\n', ''), null],
      [wallets.replace('# total_tdh: 1827', '# total_tdh: 01827'), null],
      [
        wallets.replace('# total_tdh: 1827', '# total_tdh: 9007199254740992'),
        null
      ],
      [wallets.replace('wallet,cid,', 'wallet,CID,'), null],
      [wallets.replace(',1500,1000,2,', ',1500,1000,0,'), null],
      [wallets.replace(`0x${'2'.repeat(40)}`, `0x${'2'.repeat(39)}`), null],
      [wallets.replace(',1500,1000,2,', ',1500,-1,2,'), null],
      [wallets, tokens.replace('# total_tdh: 1827', '# total_tdh: 1828')],
      [wallets, tokens.replace(',10000000013,', ',1e10,')],
      [wallets + wallets.split('\n').slice(-2)[0] + ',extra\n', null]
    ];
    for (const [w, t] of cases) {
      expect(() => parseDayFiles(w, t)).toThrow(TdhDayFileError);
    }
  });
});
