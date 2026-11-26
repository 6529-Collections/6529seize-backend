import fc from 'fast-check';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('reads the final-list format, quoted fields included', () => {
    const text =
      'date,contract,token_id,count,profile,airdrop_address,consolidation_key,balance,subscribed_at\n' +
      '2026-11-25,0xc,500,2,-,0x01,0x01-0x02,0.13058,2026-10-01T00:00:00.000Z\n' +
      '2026-11-25,0xc,500,1,"a,b ""q""",null,0x03,1,x\n';
    expect(parseCsv(text)).toEqual([
      {
        date: '2026-11-25',
        contract: '0xc',
        token_id: '500',
        count: '2',
        profile: '-',
        airdrop_address: '0x01',
        consolidation_key: '0x01-0x02',
        balance: '0.13058',
        subscribed_at: '2026-10-01T00:00:00.000Z'
      },
      {
        date: '2026-11-25',
        contract: '0xc',
        token_id: '500',
        count: '1',
        profile: 'a,b "q"',
        airdrop_address: 'null',
        consolidation_key: '0x03',
        balance: '1',
        subscribed_at: 'x'
      }
    ]);
  });

  it('reads CRLF and a missing final newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' }
    ]);
  });

  it('refuses a short row and an open quote', () => {
    expect(() => parseCsv('a,b\n1\n')).toThrow('1 fields');
    expect(() => parseCsv('a\n"x\n')).toThrow('quoted');
  });

  it('round-trips quoted values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
        (values) => {
          const quote = (v: string) => `"${v.split('"').join('""')}"`;
          const header = values.map((_, i) => `c${i}`).join(',');
          const row = values.map(quote).join(',');
          const parsed = parseCsv(`${header}\n${row}\n`);
          expect(parsed).toHaveLength(1);
          values.forEach((v, i) => expect(parsed[0][`c${i}`]).toBe(v));
        }
      )
    );
  });
});
