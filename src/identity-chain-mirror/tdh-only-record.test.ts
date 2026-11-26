import {
  formatTdhOnlyRecord,
  parseTdhOnlyRecord,
  sha256Hex,
  TdhOnlyAddressKey,
  TdhOnlyIdentityRow,
  TdhOnlyRecordError
} from './tdh-only-record';

// Made-up wallets: 0x111…, 0x222…, 0x333…, 0xaaa…
const w = (c: string) => `0x${c.repeat(40)}`;
const A = w('1');
const B = w('2');
const C = w('3');
const D = w('a');

const ROWS: TdhOnlyIdentityRow[] = [
  {
    consolidation_key: `${B}-${C}`,
    profile_id: '00000000-0000-4000-8000-000000000002',
    primary_address: C,
    tdh: 1250,
    rep: 0,
    cic: 0,
    level_raw: 1250
  },
  {
    consolidation_key: A,
    profile_id: '00000000-0000-4000-8000-000000000001',
    primary_address: A,
    tdh: 7,
    rep: -3,
    cic: 0,
    level_raw: 4
  },
  {
    consolidation_key: D,
    profile_id: null,
    primary_address: D,
    tdh: 0,
    rep: 0,
    cic: 0,
    level_raw: 0
  }
];

const KEYS: TdhOnlyAddressKey[] = [
  { address: C, consolidation_key: `${B}-${C}` },
  { address: D, consolidation_key: D },
  { address: A, consolidation_key: A },
  { address: B, consolidation_key: `${B}-${C}` }
];

const IDENTITIES_TSV =
  'consolidation_key\tprofile_id\tprimary_address\ttdh\trep\tcic\tlevel_raw\n' +
  `${A}\t00000000-0000-4000-8000-000000000001\t${A}\t7\t-3\t0\t4\n` +
  `${B}-${C}\t00000000-0000-4000-8000-000000000002\t${C}\t1250\t0\t0\t1250\n` +
  `${D}\tNULL\t${D}\t0\t0\t0\t0\n`;

const KEYS_TSV =
  'address\tconsolidation_key\n' +
  `${A}\t${A}\n` +
  `${B}\t${B}-${C}\n` +
  `${C}\t${B}-${C}\n` +
  `${D}\t${D}\n`;

// Pinned: a change to the format changes these, and the rebuild's pins.
const IDENTITIES_SHA256 =
  'f58cf7d57810ae0e8a1d4ac83fd6a176cfb68a1a82c461a8d862043658f7d146';
const KEYS_SHA256 =
  '53b5230475d943b7c2aa4c416c65e78830854f2718dccbe934661b6753b34312';

const pins = {
  identitiesSha256: IDENTITIES_SHA256,
  keysSha256: KEYS_SHA256
};

function refused(identities: string, keys: string): string {
  try {
    parseTdhOnlyRecord(identities, keys, {
      identitiesSha256: sha256Hex(identities),
      keysSha256: sha256Hex(keys)
    });
  } catch (e) {
    expect(e).toBeInstanceOf(TdhOnlyRecordError);
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('formatTdhOnlyRecord', () => {
  it('writes the shared format, sorted, with its pinned sha256', () => {
    const out = formatTdhOnlyRecord(ROWS, KEYS);
    expect(out.identitiesTsv).toBe(IDENTITIES_TSV);
    expect(out.keysTsv).toBe(KEYS_TSV);
    expect(out.identitiesSha256).toBe(IDENTITIES_SHA256);
    expect(out.keysSha256).toBe(KEYS_SHA256);
  });

  it('writes an empty record as the two header lines', () => {
    const out = formatTdhOnlyRecord([], []);
    expect(out.identitiesTsv).toBe(
      'consolidation_key\tprofile_id\tprimary_address\ttdh\trep\tcic\tlevel_raw\n'
    );
    expect(out.keysTsv).toBe('address\tconsolidation_key\n');
  });

  it('refuses values the format cannot hold', () => {
    const bad = (row: Partial<TdhOnlyIdentityRow>) => () =>
      formatTdhOnlyRecord([{ ...ROWS[1], ...row }], []);
    expect(bad({ consolidation_key: A.toUpperCase() })).toThrow(
      TdhOnlyRecordError
    );
    expect(bad({ profile_id: 'NULL' })).toThrow(TdhOnlyRecordError);
    expect(bad({ profile_id: 'has\ttab' })).toThrow(TdhOnlyRecordError);
    expect(bad({ tdh: 1.5 })).toThrow(TdhOnlyRecordError);
    expect(() => formatTdhOnlyRecord([ROWS[1], { ...ROWS[1] }], [])).toThrow(
      TdhOnlyRecordError
    );
  });
});

describe('parseTdhOnlyRecord', () => {
  it('reads the pinned record back to the same rows and keys', () => {
    const record = parseTdhOnlyRecord(IDENTITIES_TSV, KEYS_TSV, pins);
    const byKey = (a: TdhOnlyIdentityRow, b: TdhOnlyIdentityRow) =>
      a.consolidation_key < b.consolidation_key ? -1 : 1;
    expect(record.rows).toEqual([...ROWS].sort(byKey));
    expect(record.keys.map((k) => k.address)).toEqual([A, B, C, D]);
    expect(record.rows.find((r) => r.primary_address === D)?.profile_id).toBe(
      null
    );
  });

  it('refuses a file whose sha256 is not the pinned one', () => {
    expect(() =>
      parseTdhOnlyRecord(IDENTITIES_TSV, KEYS_TSV, {
        ...pins,
        identitiesSha256: sha256Hex('something else')
      })
    ).toThrow('identities: the sha256 does not match the pinned one');
    expect(() =>
      parseTdhOnlyRecord(IDENTITIES_TSV, KEYS_TSV, {
        ...pins,
        keysSha256: sha256Hex('something else')
      })
    ).toThrow('address keys: the sha256 does not match the pinned one');
  });

  it('refuses a byte order mark, CRLF and a missing final line feed', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(refused(`${bom}${IDENTITIES_TSV}`, KEYS_TSV)).toContain(
      'byte order mark'
    );
    expect(refused(IDENTITIES_TSV.replace(/\n/g, '\r\n'), KEYS_TSV)).toContain(
      'carriage return'
    );
    expect(refused(IDENTITIES_TSV, KEYS_TSV.slice(0, -1))).toContain(
      'does not end with a line feed'
    );
  });

  it('refuses another header or a line with the wrong number of fields', () => {
    expect(
      refused(IDENTITIES_TSV.replace('level_raw', 'level'), KEYS_TSV)
    ).toContain('the header is not');
    expect(
      refused(IDENTITIES_TSV.replace('\t-3\t', '\t-3\t\t'), KEYS_TSV)
    ).toContain('has 8 fields, not 7');
  });

  it('refuses rows out of order or repeated', () => {
    const lines = IDENTITIES_TSV.split('\n');
    const swapped = [lines[0], lines[2], lines[1], lines[3], ''].join('\n');
    expect(refused(swapped, KEYS_TSV)).toContain('is not after line');
    const keyLines = KEYS_TSV.split('\n');
    const repeated = [
      ...keyLines.slice(0, 2),
      keyLines[1],
      ...keyLines.slice(2)
    ].join('\n');
    expect(refused(IDENTITIES_TSV, repeated)).toContain('is not after line');
  });

  it('refuses a number, a wallet or a key it cannot read', () => {
    expect(
      refused(IDENTITIES_TSV.replace('\t1250\t0', '\t1,250\t0'), KEYS_TSV)
    ).toContain('is not a decimal integer');
    expect(
      refused(
        IDENTITIES_TSV.replace(`\t${A}\t7`, '\tnot-a-wallet\t7'),
        KEYS_TSV
      )
    ).toContain('is not a lowercase wallet');
    expect(
      refused(
        IDENTITIES_TSV,
        KEYS_TSV.replace(`${D}\t${D}`, `${D}\t${D.toUpperCase()}`)
      )
    ).toContain('is not wallets joined by');
  });

  it('refuses an address key with no identities row, or outside its key', () => {
    expect(
      refused(
        IDENTITIES_TSV,
        KEYS_TSV.replace(`${D}\t${D}`, `${D}\t${D}-${w('b')}`)
      )
    ).toContain('no identities row has key');
    expect(
      refused(IDENTITIES_TSV, KEYS_TSV.replace(`${D}\t${D}`, `${D}\t${A}`))
    ).toContain('is not a wallet of its key');
  });

  it('refuses a primary address used by two rows', () => {
    const twice = IDENTITIES_TSV.replace(`\t${D}\t0\t`, `\t${A}\t0\t`);
    expect(refused(twice, KEYS_TSV)).toContain('repeats');
  });
});
