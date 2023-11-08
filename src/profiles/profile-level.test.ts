import { tdh2Level } from './profile-level';

describe('Profile Level', () => {
  it('resolves when tdh is negative', () => {
    expect(tdh2Level(-1)).toBe(0);
  });

  it('resolves when tdh is 0', () => {
    expect(tdh2Level(0)).toBe(0);
  });

  it('resolves when tdh is 24', () => {
    expect(tdh2Level(24)).toBe(0);
  });

  it('resolves when tdh is 10000', () => {
    expect(tdh2Level(25)).toBe(1);
  });

  it('resolves when tdh is 25', () => {
    expect(tdh2Level(12999)).toBe(11);
  });

  it('resolves when tdh is extremely large', () => {
    expect(tdh2Level(99999999999)).toBe(100);
  });
});
