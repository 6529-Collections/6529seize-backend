jest.mock('@/db-api', () => ({}));

import fc from 'fast-check';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { BadRequestException } from '@/exceptions';
import { MAX_REMEME_MEME_ID_DIGITS } from '@/rememe-meme-id';
import { MAX_REMEMES_MEME_IDS, RememesQuerySchema } from './rememes.routes';

function validate(query: Record<string, unknown>) {
  return getValidatedByJoiOrThrow(query, RememesQuerySchema);
}

describe('rememes query validation', () => {
  it('accepts the queries the site sends', () => {
    expect(
      validate({
        meme_id: '42',
        page_size: '40',
        page: '1',
        token_type: 'ERC721',
        sort: 'created_at',
        sort_direction: 'desc'
      })
    ).toMatchObject({ meme_id: '42', token_type: 'ERC721' });
    expect(
      validate({
        contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
        id: '12345'
      })
    ).toMatchObject({ id: '12345' });
    expect(validate({ meme_id: '' })).toEqual({ meme_id: '' });
  });

  it('accepts up to the maximum number of comma-separated meme ids', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(), { minLength: 1, maxLength: MAX_REMEMES_MEME_IDS }),
        (ids) => {
          const meme_id = ids.join(',');
          expect(validate({ meme_id }).meme_id).toBe(meme_id);
        }
      )
    );
  });

  it('normalises meme ids with leading zeros to canonical integers', () => {
    expect(validate({ meme_id: '007,0,000,10' }).meme_id).toBe('7,0,0,10');
    fc.assert(
      fc.property(fc.nat(), fc.nat({ max: 5 }), (id, zeros) => {
        expect(validate({ meme_id: '0'.repeat(zeros) + id }).meme_id).toBe(
          String(id)
        );
      })
    );
  });

  it('accepts canonical ids up to the digit limit only', () => {
    expect(validate({ meme_id: '9'.repeat(15) }).meme_id).toBe('9'.repeat(15));
    expect(validate({ meme_id: '00000' + '9'.repeat(15) }).meme_id).toBe(
      '9'.repeat(15)
    );
    expect(() => validate({ meme_id: '1' + '0'.repeat(15) })).toThrow(
      BadRequestException
    );
    expect(() => validate({ meme_id: '1'.repeat(21) })).toThrow(
      BadRequestException
    );
  });

  it('reports over-long ids with the same error as other malformed ids', () => {
    const patternError = /fails to match the comma-separated meme ids pattern/;
    expect(() => validate({ meme_id: '1,a' })).toThrow(patternError);
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_REMEME_MEME_ID_DIGITS + 1, max: 25 }),
        fc.integer({ min: 1, max: 9 }),
        fc.nat({ max: 3 }),
        (digits, leading, zeros) => {
          const id = '0'.repeat(zeros) + leading + '0'.repeat(digits - 1);
          expect(() => validate({ meme_id: `1,${id}` })).toThrow(patternError);
        }
      )
    );
  });

  it('rejects more meme ids than the maximum', () => {
    const meme_id = Array.from(
      { length: MAX_REMEMES_MEME_IDS + 1 },
      (_, i) => i
    ).join(',');
    expect(() => validate({ meme_id })).toThrow(BadRequestException);
  });

  it.each([
    { meme_id: '1,a' },
    { meme_id: '-1' },
    { meme_id: '1,,2' },
    { meme_id: '1 OR 1' },
    { meme_id: ['1', '2'] },
    { contract: { a: 1 } },
    { contract: '0x1;' },
    { id: 'x'.repeat(101) },
    { id: ['1'] },
    { token_type: 'ERC 721' }
  ])('rejects %p', (query) => {
    expect(() => validate(query)).toThrow(BadRequestException);
  });
});
