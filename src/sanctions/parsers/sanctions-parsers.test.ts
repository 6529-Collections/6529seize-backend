import { readFileSync } from 'fs';
import * as path from 'path';
import { parseCaSemaXml } from '@/sanctions/parsers/ca-sema-xml.parser';
import { parseChSecoXml } from '@/sanctions/parsers/ch-seco-xml.parser';
import { parseEuFsfXml } from '@/sanctions/parsers/eu-fsf-xml.parser';
import { parseIlNbctfApi } from '@/sanctions/parsers/il-nbctf-api.parser';
import { parseJpMofCsv } from '@/sanctions/parsers/jp-mof-csv.parser';
import { parseKrFscPinned } from '@/sanctions/parsers/kr-fsc-pinned.parser';
import { parseOfacSdnXml } from '@/sanctions/parsers/ofac-sdn-xml.parser';
import type {
  RawSanctionsListing,
  SanctionsInputFile
} from '@/sanctions/parsers/sanctions-parser.types';
import { parseUkFcdoXml } from '@/sanctions/parsers/uk-fcdo-xml.parser';
import { SANCTIONS_SPEC_DIR } from '@/sanctions/sanctions-spec-files';

const INPUTS = path.join(SANCTIONS_SPEC_DIR, 'fixtures', 'inputs');

function fixture(source: string, ...names: string[]): SanctionsInputFile[] {
  return names.map((name) => ({
    name,
    bytes: readFileSync(path.join(INPUTS, source, name))
  }));
}

function addressesOf(listings: RawSanctionsListing[]): string[] {
  return Array.from(new Set(listings.map((listing) => listing.address))).sort();
}

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('ofac-sdn-xml', () => {
  const parsed = parseOfacSdnXml(fixture('us-ofac-sdn', 'SDN.XML'));

  it('reads the publish date (MM/DD/YYYY)', () => {
    expect(parsed.source_published).toBe('2026-01-15');
  });

  it('takes EVM digital-currency ids under any ticker and skips the rest', () => {
    expect(addressesOf(parsed.listings)).toEqual([
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
      A
    ]);
    expect(
      parsed.listings
        .filter((listing) => listing.address === A)
        .map((listing) => `${listing.entry_id}:${listing.labels.join()}`)
        .sort()
    ).toEqual(['1001:ETH', '1001:USDT', '1002:ETH']);
  });

  it('does not take EVM-looking values of other id types', () => {
    const registration = parsed.listings.filter(
      (listing) =>
        listing.address === '0x3333333333333333333333333333333333333333'
    );
    expect(registration.map((listing) => listing.entry_id)).toEqual(['1002']);
  });

  it('rejects a document with another root element', () => {
    expect(() =>
      parseOfacSdnXml([{ name: 'SDN.XML', bytes: Buffer.from('<other/>') }])
    ).toThrow(/unexpected root/);
  });
});

describe('uk-fcdo-xml', () => {
  const parsed = parseUkFcdoXml(fixture('uk-fcdo', 'UK-Sanctions-List.xml'));

  it('never matches glued addresses', () => {
    expect(addressesOf(parsed.listings)).toEqual([
      '0x4444444444444444444444444444444444444444',
      '0x7777777777777777777777777777777777777777'
    ]);
    expect(parsed.scanned_addresses).toEqual(addressesOf(parsed.listings));
  });

  it('keeps the ticker written before each address', () => {
    expect(
      parsed.listings
        .filter((listing) => listing.entry_id === 'TST0001')
        .map((listing) => listing.labels[0])
    ).toEqual(['ETH', 'BNB']);
  });

  it('reads the primary name, regime and DD/MM/YYYY dates', () => {
    const [first] = parsed.listings;
    expect(first.entity).toBe('Test UK PERSON');
    expect(first.programs).toEqual(['The Test (Sanctions) Regulations 2019']);
    expect(first.listed_on).toBe('2024-03-27');
    expect(parsed.source_published).toBe('2026-01-02');
  });
});

describe('eu-fsf-xml', () => {
  const parsed = parseEuFsfXml(
    fixture('eu-fsf', 'xmlFullSanctionsList_1_1.xml')
  );

  it('reads addresses from remarks with their tickers', () => {
    expect(
      parsed.listings.map((listing) => [listing.address, listing.labels])
    ).toEqual([
      ['0x8888888888888888888888888888888888888888', ['ETH']],
      ['0x9999999999999999999999999999999999999999', ['BSC']]
    ]);
    expect(parsed.listings[0]).toMatchObject({
      entry_id: 'EU.1.1',
      entity: 'Test EU Exchange',
      programs: ['UKR'],
      listed_on: '2025-02-24'
    });
    expect(parsed.source_published).toBe('2026-01-20');
  });
});

describe('ch-seco-xml', () => {
  const parsed = parseChSecoXml(fixture('ch-seco', 'consolidated-list.xml'));

  it('reads only the current subject, not the modification history', () => {
    expect(addressesOf(parsed.listings)).toEqual([
      '0x8888888888888888888888888888888888888888',
      '0x9999999999999999999999999999999999999999'
    ]);
    expect(parsed.scanned_addresses).not.toContain(
      '0x1414141414141414141414141414141414141414'
    );
  });

  it('orders name parts and resolves the programme', () => {
    expect(parsed.listings[0]).toMatchObject({
      entry_id: '100',
      entity: 'Test CH Exchange',
      programs: ['Situation in Ukraine'],
      listed_on: '2025-03-04'
    });
  });
});

describe('jp-mof-csv', () => {
  const files = fixture('jp-mof', 'shisantouketsu20260105.csv');
  const parsed = parseJpMofCsv(files);

  it('reads the other-information column, including run-on text', () => {
    expect(addressesOf(parsed.listings)).toEqual([
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '0xcccccccccccccccccccccccccccccccccccccccc',
      '0xdddddddddddddddddddddddddddddddddddddddd'
    ]);
  });

  it('takes the date from the file name and falls back to the Japanese name', () => {
    expect(parsed.source_published).toBe('2026-01-05');
    const runOn = parsed.listings.find(
      (listing) => listing.entry_id === '017-000002'
    );
    expect(runOn).toMatchObject({
      entity: 'テスト・ジロウ',
      listed_on: '2023-01-31',
      programs: ['区分 17']
    });
  });

  it('refuses a file name without the list date', () => {
    expect(() =>
      parseJpMofCsv([{ name: 'list.csv', bytes: files[0].bytes }])
    ).toThrow(/list date/);
  });
});

describe('kr-fsc-pinned', () => {
  const files = fixture('kr-fsc', 'kr-fsc.pinned.json');

  it('emits the reviewed entries', () => {
    const parsed = parseKrFscPinned(files);
    expect(parsed.source_published).toBe('2026-01-14');
    expect(addressesOf(parsed.listings)).toEqual([
      '0x1313131313131313131313131313131313131313',
      A
    ]);
  });

  it('refuses an invalid address', () => {
    const pinned = JSON.parse(files[0].bytes.toString('utf8'));
    pinned.entries[0].addresses[0].address = '0x123';
    expect(() =>
      parseKrFscPinned([
        { name: files[0].name, bytes: Buffer.from(JSON.stringify(pinned)) }
      ])
    ).toThrow(/invalid address/);
  });

  it('validates the real pinned file shipped with the builder', () => {
    const real = readFileSync(
      path.join(__dirname, '..', 'sources', 'kr-fsc.pinned.json')
    );
    const parsed = parseKrFscPinned([
      { name: 'kr-fsc.pinned.json', bytes: real }
    ]);
    expect(addressesOf(parsed.listings)).toHaveLength(10);
  });
});

describe('il-nbctf-api', () => {
  const parsed = parseIlNbctfApi(
    fixture('il-nbctf', 'wallets-0.json', 'orders-0.json')
  );

  it('lists one entry per order with its validity date', () => {
    expect(
      parsed.listings.map((listing) => [
        listing.address,
        listing.entry_id,
        listing.valid_until
      ])
    ).toEqual([
      ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'FO 01/25', '2028-04-29'],
      ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'FO 02/24', '2026-07-31'],
      ['0xffffffffffffffffffffffffffffffffffffffff', 'FO 02/24', '2026-07-31']
    ]);
  });

  it('drops wallets whose only order was cancelled, and says so', () => {
    expect(addressesOf(parsed.listings)).not.toContain(
      '0x1212121212121212121212121212121212121212'
    );
    expect(parsed.excluded_addresses).toEqual([
      '0x1212121212121212121212121212121212121212'
    ]);
  });

  it('uses the newest order date as the publication date', () => {
    expect(parsed.source_published).toBe('2025-01-26');
  });

  it('refuses unexpected input files', () => {
    expect(() =>
      parseIlNbctfApi([{ name: 'other.json', bytes: Buffer.from('{}') }])
    ).toThrow(/unexpected input file/);
  });
});

describe('ca-sema-xml', () => {
  it('yields no listings and dates the list by its latest listing', () => {
    const parsed = parseCaSemaXml(fixture('ca-sema', 'sema-lmes.xml'));
    expect(parsed.listings).toEqual([]);
    expect(parsed.scanned_addresses).toEqual([]);
    expect(parsed.source_published).toBe('2025-12-01');
  });

  it('never expands DTD entities (no entity-expansion attacks)', () => {
    const xml =
      '<!DOCTYPE data-set [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>' +
      '<data-set><record><LastName-NomDeFamille>&b;</LastName-NomDeFamille></record></data-set>';
    expect(() =>
      parseCaSemaXml([{ name: 'sema-lmes.xml', bytes: Buffer.from(xml) }])
    ).toThrow(/Invalid character entity/);
  });

  it('rejects malformed XML', () => {
    expect(() =>
      parseCaSemaXml([
        { name: 'sema-lmes.xml', bytes: Buffer.from('<data-set><record>') }
      ])
    ).toThrow();
  });
});
