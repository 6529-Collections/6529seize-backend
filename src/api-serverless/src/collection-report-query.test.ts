import fc from 'fast-check';
import { BadRequestException } from '@/exceptions';
import {
  artistListRegExp,
  escapeMysqlRegExp,
  parseCollectionReportQuery
} from './collection-report-query';

describe('parseCollectionReportQuery', () => {
  it('parses the query the web app sends', () => {
    expect(
      parseCollectionReportQuery({
        from_date: '2026-01-01',
        to_date: '2026-01-31',
        artist: 'Some Artist'
      })
    ).toEqual({
      primary: false,
      artist: 'Some Artist',
      from_date: '2026-01-01',
      to_date: '2026-01-31',
      from_block: undefined,
      to_block: undefined,
      download: false
    });
    expect(
      parseCollectionReportQuery({
        primary: 'true',
        from_block: '100',
        to_block: '200',
        download: 'true'
      })
    ).toMatchObject({
      primary: true,
      from_block: 100,
      to_block: 200,
      download: true
    });
  });

  it('accepts ISO date-times', () => {
    expect(
      parseCollectionReportQuery({ from_date: '2026-01-01T10:00:00Z' })
        .from_date
    ).toBe('2026-01-01T10:00:00Z');
  });

  it.each(['yesterday', '2026-13-45', '01/02/2026', '2026-01-01; x'])(
    'rejects the date %p',
    (value) => {
      expect(() => parseCollectionReportQuery({ from_date: value })).toThrow(
        BadRequestException
      );
    }
  );

  it('rejects an overlong artist and repeated parameters', () => {
    expect(() =>
      parseCollectionReportQuery({ artist: 'a'.repeat(201) })
    ).toThrow(BadRequestException);
    expect(() => parseCollectionReportQuery({ artist: ['a', 'b'] })).toThrow(
      BadRequestException
    );
  });

  it('treats empty values as absent', () => {
    expect(
      parseCollectionReportQuery({ artist: '', from_date: '', to_date: '' })
    ).toMatchObject({
      artist: undefined,
      from_date: undefined,
      to_date: undefined
    });
  });
});

describe('artistListRegExp', () => {
  it('matches the artist name literally', () => {
    const regex = new RegExp(artistListRegExp('A.B (C)'));
    expect(regex.test('A.B (C)')).toBe(true);
    expect(regex.test('X,A.B (C)')).toBe(true);
    expect(regex.test('Z and A.B (C)')).toBe(true);
    expect(regex.test('AxB (C)')).toBe(false);
    expect(regex.test('A.B C')).toBe(false);
  });

  it('escapes every special character so any name compiles to a literal match', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (name) => {
        const regex = new RegExp(`^${escapeMysqlRegExp(name)}$`);
        expect(regex.test(name)).toBe(true);
      })
    );
  });
});
