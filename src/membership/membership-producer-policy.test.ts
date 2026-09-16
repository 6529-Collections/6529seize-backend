import {
  isMembershipSourceTrackingEnabled,
  resolveMembershipSourceTrackingMode
} from './membership-producer-policy';

describe('membership source tracking deployment control', () => {
  it('defaults to inactive across stages and requires explicit staging activation', () => {
    expect(resolveMembershipSourceTrackingMode(undefined, 'staging')).toBe(
      'inactive'
    );
    expect(resolveMembershipSourceTrackingMode(undefined, 'prod')).toBe(
      'inactive'
    );
    expect(isMembershipSourceTrackingEnabled('inactive', 'staging')).toBe(
      false
    );
    expect(isMembershipSourceTrackingEnabled('tracking-v1', 'staging')).toBe(
      true
    );
  });

  it.each([undefined, 'prod', 'production', 'test'])(
    'refuses tracking without exact staging identity %s',
    (stage) => {
      expect(() =>
        resolveMembershipSourceTrackingMode('tracking-v1', stage)
      ).toThrow('Invalid membership source tracking deployment');
    }
  );

  it.each(['', 'enabled', 'TRACKING-V1', 'tracking-v2'])(
    'rejects unsupported mode %s',
    (mode) => {
      expect(() =>
        resolveMembershipSourceTrackingMode(mode, 'staging')
      ).toThrow('Invalid membership source tracking deployment');
    }
  );
});
