import { enums, TokenType } from '../enums';

describe('enums.resolve', () => {
  const testEnum = {
    VALUE_ONE: 'value1',
    VALUE_TWO: 'value2',
    VALUE_THREE: 'value3'
  };

  describe('successful resolution', () => {
    it('returns enum value for exact match', () => {
      expect(enums.resolve(testEnum, 'value1')).toBe('value1');
      expect(enums.resolve(testEnum, 'value2')).toBe('value2');
      expect(enums.resolve(testEnum, 'value3')).toBe('value3');
    });

    it('returns enum value for case-insensitive match', () => {
      expect(enums.resolve(testEnum, 'VALUE1')).toBe('value1');
      expect(enums.resolve(testEnum, 'Value2')).toBe('value2');
      expect(enums.resolve(testEnum, 'VALUE3')).toBe('value3');
    });

    it('works with TokenType enum', () => {
      expect(enums.resolve(TokenType, 'ERC721')).toBe(TokenType.ERC721);
      expect(enums.resolve(TokenType, 'erc721')).toBe(TokenType.ERC721);
      expect(enums.resolve(TokenType, 'ERC1155')).toBe(TokenType.ERC1155);
      expect(enums.resolve(TokenType, 'erc1155')).toBe(TokenType.ERC1155);
    });
  });

  describe('returns undefined for invalid values', () => {
    it('returns undefined for invalid enum value', () => {
      expect(enums.resolve(testEnum, 'invalid')).toBeUndefined();
    });

    it('returns undefined for undefined value', () => {
      expect(enums.resolve(testEnum, undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(enums.resolve(testEnum, '')).toBeUndefined();
    });

    it('returns undefined for null value', () => {
      expect(enums.resolve(testEnum, null as any)).toBeUndefined();
    });

    it('returns undefined for non-existent value in TokenType', () => {
      expect(enums.resolve(TokenType, 'ERC20')).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty enum object', () => {
      const emptyEnum = {};
      expect(enums.resolve(emptyEnum, 'anything')).toBeUndefined();
    });

    it('handles enum with numeric values', () => {
      const numericEnum = {
        FIRST: 1,
        SECOND: 2,
        THIRD: 3
      };
      expect(enums.resolve(numericEnum, '1')).toBe(1);
      expect(enums.resolve(numericEnum, '2')).toBe(2);
      expect(enums.resolve(numericEnum, '4')).toBeUndefined();
    });

    it('handles enum with boolean values', () => {
      const booleanEnum = {
        TRUE_VALUE: true,
        FALSE_VALUE: false
      };
      expect(enums.resolve(booleanEnum, 'true')).toBe(true);
      expect(enums.resolve(booleanEnum, 'false')).toBe(false);
      expect(enums.resolve(booleanEnum, 'TRUE')).toBe(true);
      expect(enums.resolve(booleanEnum, 'maybe')).toBeUndefined();
    });

    it('handles enum with mixed value types', () => {
      const mixedEnum = {
        STRING_VAL: 'text',
        NUMBER_VAL: 42,
        BOOLEAN_VAL: true
      };
      expect(enums.resolve(mixedEnum, 'text')).toBe('text');
      expect(enums.resolve(mixedEnum, '42')).toBe(42);
      expect(enums.resolve(mixedEnum, 'true')).toBe(true);
      expect(enums.resolve(mixedEnum, 'nonexistent')).toBeUndefined();
    });
  });
});

describe('enums.resolveOrThrow', () => {
  const testEnum = {
    VALUE_ONE: 'value1',
    VALUE_TWO: 'value2',
    VALUE_THREE: 'value3'
  };

  describe('successful resolution', () => {
    it('returns enum value for exact match', () => {
      expect(enums.resolveOrThrow(testEnum, 'value1')).toBe('value1');
      expect(enums.resolveOrThrow(testEnum, 'value2')).toBe('value2');
      expect(enums.resolveOrThrow(testEnum, 'value3')).toBe('value3');
    });

    it('returns enum value for case-insensitive match', () => {
      expect(enums.resolveOrThrow(testEnum, 'VALUE1')).toBe('value1');
      expect(enums.resolveOrThrow(testEnum, 'Value2')).toBe('value2');
      expect(enums.resolveOrThrow(testEnum, 'VALUE3')).toBe('value3');
    });

    it('works with TokenType enum', () => {
      expect(enums.resolveOrThrow(TokenType, 'ERC721')).toBe(TokenType.ERC721);
      expect(enums.resolveOrThrow(TokenType, 'erc721')).toBe(TokenType.ERC721);
      expect(enums.resolveOrThrow(TokenType, 'ERC1155')).toBe(
        TokenType.ERC1155
      );
      expect(enums.resolveOrThrow(TokenType, 'erc1155')).toBe(
        TokenType.ERC1155
      );
    });
  });

  describe('error cases', () => {
    it('throws error for invalid enum value', () => {
      expect(() => enums.resolveOrThrow(testEnum, 'invalid')).toThrow(
        'Invalid enum value: invalid'
      );
    });

    it('throws error for undefined value', () => {
      expect(() => enums.resolveOrThrow(testEnum, undefined)).toThrow(
        'Invalid enum value: undefined'
      );
    });

    it('throws error for empty string', () => {
      expect(() => enums.resolveOrThrow(testEnum, '')).toThrow(
        'Invalid enum value: '
      );
    });

    it('throws error for null value', () => {
      expect(() => enums.resolveOrThrow(testEnum, null as any)).toThrow(
        'Invalid enum value: null'
      );
    });

    it('throws error for non-existent value in TokenType', () => {
      expect(() => enums.resolveOrThrow(TokenType, 'ERC20')).toThrow(
        'Invalid enum value: ERC20'
      );
    });
  });

  describe('edge cases', () => {
    it('handles empty enum object', () => {
      const emptyEnum = {};
      expect(() => enums.resolveOrThrow(emptyEnum, 'anything')).toThrow(
        'Invalid enum value: anything'
      );
    });

    it('handles enum with numeric values', () => {
      const numericEnum = {
        FIRST: 1,
        SECOND: 2,
        THIRD: 3
      };
      expect(enums.resolveOrThrow(numericEnum, '1')).toBe(1);
      expect(enums.resolveOrThrow(numericEnum, '2')).toBe(2);
      expect(() => enums.resolveOrThrow(numericEnum, '4')).toThrow(
        'Invalid enum value: 4'
      );
    });

    it('handles enum with boolean values', () => {
      const booleanEnum = {
        TRUE_VALUE: true,
        FALSE_VALUE: false
      };
      expect(enums.resolveOrThrow(booleanEnum, 'true')).toBe(true);
      const actual = enums.resolveOrThrow(booleanEnum, 'false');
      expect(actual).toBe(false);
      expect(enums.resolveOrThrow(booleanEnum, 'TRUE')).toBe(true);
      expect(() => enums.resolveOrThrow(booleanEnum, 'maybe')).toThrow(
        'Invalid enum value: maybe'
      );
    });
  });
});
