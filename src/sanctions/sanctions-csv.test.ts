import { parseCsv } from '@/sanctions/sanctions-csv';

describe('parseCsv', () => {
  it.each([
    [
      'a,b\nc,d\n',
      [
        ['a', 'b'],
        ['c', 'd']
      ]
    ],
    [
      'a,b\r\nc,d',
      [
        ['a', 'b'],
        ['c', 'd']
      ]
    ],
    ['"x, y","say ""hi"""\n', [['x, y', 'say "hi"']]],
    ['"multi\nline",z\n', [['multi\nline', 'z']]],
    ['a,,\n', [['a', '', '']]],
    ['', []]
  ])('parses %j', (text, rows) => {
    expect(parseCsv(text)).toEqual(rows);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('"open,field\n')).toThrow(/Unterminated/);
  });
});
