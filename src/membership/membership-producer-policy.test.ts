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

  it('freezes deployment-owned controls before later secret loading can alter env', () => {
    const oldMode = process.env.MEMBERSHIP_SOURCE_TRACKING_MODE;
    const oldStage = process.env.MEMBERSHIP_SOURCE_TRACKING_STAGE;
    try {
      process.env.MEMBERSHIP_SOURCE_TRACKING_MODE = 'tracking-v1';
      process.env.MEMBERSHIP_SOURCE_TRACKING_STAGE = 'staging';
      let policy!: typeof import('./membership-producer-policy');
      jest.isolateModules(() => {
        policy = require('./membership-producer-policy');
      });
      process.env.MEMBERSHIP_SOURCE_TRACKING_MODE = 'inactive';
      process.env.MEMBERSHIP_SOURCE_TRACKING_STAGE = 'prod';
      expect(policy.isMembershipSourceTrackingActive()).toBe(true);
      expect(policy.membershipSourceTrackingDeployment).toEqual({
        mode: 'tracking-v1',
        stage: 'staging'
      });
    } finally {
      if (oldMode === undefined)
        delete process.env.MEMBERSHIP_SOURCE_TRACKING_MODE;
      else process.env.MEMBERSHIP_SOURCE_TRACKING_MODE = oldMode;
      if (oldStage === undefined)
        delete process.env.MEMBERSHIP_SOURCE_TRACKING_STAGE;
      else process.env.MEMBERSHIP_SOURCE_TRACKING_STAGE = oldStage;
    }
  });
});
