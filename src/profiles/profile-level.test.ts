import { calculateLevel } from './profile-level';

describe('Profile Level', () => {
  it('resolves when tdh is negative', () => {
    expect(calculateLevel({ tdh: -1, rep: 0 })).toBe(0);
  });

  it('resolves when tdh is 0', () => {
    expect(calculateLevel({ tdh: 0, rep: 0 })).toBe(0);
  });

  it('resolves when tdh is 24', () => {
    expect(calculateLevel({ tdh: 24, rep: 0 })).toBe(0);
  });

  it('resolves when tdh is 10000', () => {
    expect(calculateLevel({ tdh: 10000, rep: 0 })).toBe(11);
  });

  it('resolves when tdh is 25', () => {
    expect(calculateLevel({ tdh: 25, rep: 0 })).toBe(1);
  });

  it('resolves when tdh is extremely large', () => {
    expect(calculateLevel({ tdh: 99999999999, rep: 0 })).toBe(100);
  });

  it('positive rep is added to TDH', () => {
    expect(calculateLevel({ tdh: 10000, rep: 50000 })).toBe(20);
  });

  it('negative rep is subtracted from TDH', () => {
    expect(calculateLevel({ tdh: 10000, rep: -9900 })).toBe(3);
  });
});
