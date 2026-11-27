import { compareCodeUnits } from '@/rebuild/code-units';

describe('compareCodeUnits', () => {
  it('orders by UTF-16 code unit, not by locale', () => {
    expect(['a_', 'aB', 'b', 'B', 'a_'].sort(compareCodeUnits)).toEqual([
      'B',
      'aB',
      'a_',
      'a_',
      'b'
    ]);
  });
});
