import { Numbers, numbers } from './numbers';

describe('numbers.range', () => {
  it('lists the integers from start to end inclusive', () => {
    expect(numbers.range(3, 6)).toEqual([3, 4, 5, 6]);
    expect(numbers.range(5, 5)).toEqual([5]);
    expect(numbers.range(6, 3)).toEqual([]);
  });

  it('refuses to expand past its length limit', () => {
    expect(() => numbers.range(1, 11, 10)).toThrow(RangeError);
    expect(numbers.range(1, 10, 10)).toHaveLength(10);
    expect(() => numbers.range(0, Numbers.MAX_RANGE_LENGTH)).toThrow(
      'exceeds the limit'
    );
  });

  it('refuses ends that are not safe integers', () => {
    expect(() => numbers.range(0, Number.MAX_SAFE_INTEGER + 2)).toThrow(
      'safe integers'
    );
    expect(() => numbers.range(0.5, 2)).toThrow('safe integers');
  });
});
