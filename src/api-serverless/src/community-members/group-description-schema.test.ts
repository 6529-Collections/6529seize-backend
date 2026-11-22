import { GroupDescriptionSchema } from './group-description.schema';

function validate(level: { min: number | null; max: number | null }) {
  return GroupDescriptionSchema.validate({
    tdh: { min: null, max: null },
    rep: { min: null, max: null },
    cic: { min: null, max: null },
    level,
    owns_nfts: [],
    identity_addresses: null
  });
}

describe('GroupDescriptionSchema level bounds', () => {
  it('accepts levels above 100', () => {
    for (const level of [
      { min: 101, max: null },
      { min: null, max: 150 },
      { min: 150, max: 1000 }
    ]) {
      const result = validate(level);
      expect(result.error).toBeUndefined();
      expect(result.value.level).toEqual(level);
    }
  });

  it('keeps the lower limit of -100', () => {
    expect(validate({ min: -100, max: -100 }).error).toBeUndefined();
    expect(validate({ min: -101, max: null }).error).toBeDefined();
    expect(validate({ min: null, max: -101 }).error).toBeDefined();
  });

  it('rejects levels that are not safe integers', () => {
    expect(validate({ min: 100.5, max: null }).error).toBeDefined();
    expect(
      validate({ min: null, max: Number.MAX_SAFE_INTEGER + 2 }).error
    ).toBeDefined();
  });
});
