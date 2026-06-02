import { CustomTypeCaster } from './my-sql.helpers';

const castTinyInt = CustomTypeCaster as (
  field: {
    type: string;
    string: () => string | null;
    buffer?: () => Buffer | null;
  },
  next: () => unknown
) => unknown;

describe('CustomTypeCaster', () => {
  it('casts nullable tinyint values without reading the field twice', () => {
    const field = {
      type: 'TINY',
      string: jest.fn(() => null),
      buffer: jest.fn()
    };

    const result = castTinyInt(field, jest.fn());

    expect(result).toBeNull();
    expect(field.string).toHaveBeenCalledTimes(1);
    expect(field.buffer).not.toHaveBeenCalled();
  });

  it.each([
    ['0', false],
    ['1', true]
  ])('casts tinyint %s to %s', (value, expected) => {
    const field = {
      type: 'TINY',
      string: jest.fn(() => value)
    };

    expect(castTinyInt(field, jest.fn())).toBe(expected);
    expect(field.string).toHaveBeenCalledTimes(1);
  });
});
