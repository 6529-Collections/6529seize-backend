describe('membership reader deployment controls', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  function policy() {
    let result!: { read: boolean; shadow: boolean };
    jest.isolateModules(() => {
      const module =
        require('./membership-reader-policy') as typeof import('./membership-reader-policy');
      result = module.membershipReaderPolicy('profile-1');
      // A later secrets load cannot change the controls captured at import.
      process.env.MEMBERSHIP_READ_MODE = 'staging-controlled-v1';
      process.env.MEMBERSHIP_SHADOW_MODE = 'staging-controlled-v1';
      process.env.MEMBERSHIP_READER_STAGE = 'staging';
      process.env.MEMBERSHIP_READER_PROFILE_IDS = 'profile-1';
      expect(module.membershipReaderPolicy('profile-1')).toEqual(result);
    });
    return result;
  }

  it('defaults to ordinary reads and no shadow comparison', () => {
    delete process.env.MEMBERSHIP_READ_MODE;
    delete process.env.MEMBERSHIP_SHADOW_MODE;
    delete process.env.MEMBERSHIP_READER_STAGE;
    delete process.env.MEMBERSHIP_READER_PROFILE_IDS;
    expect(policy()).toEqual({ read: false, shadow: false });
  });

  it('requires a staging identity and an explicit small cohort', () => {
    process.env.MEMBERSHIP_READ_MODE = 'staging-controlled-v1';
    process.env.MEMBERSHIP_SHADOW_MODE = 'staging-controlled-v1';
    process.env.MEMBERSHIP_READER_PROFILE_IDS = 'profile-1';
    process.env.MEMBERSHIP_READER_STAGE = 'prod';
    expect(policy()).toEqual({ read: false, shadow: false });

    process.env.MEMBERSHIP_READER_STAGE = 'staging';
    expect(policy()).toEqual({ read: true, shadow: true });
    process.env.MEMBERSHIP_READER_PROFILE_IDS = Array.from(
      { length: 21 },
      (_v, i) => `profile-${i}`
    ).join(',');
    expect(policy()).toEqual({ read: false, shadow: false });
  });
});
