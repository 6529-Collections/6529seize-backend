import * as fc from 'fast-check';
import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import {
  decideE2eePolicy,
  E2eeEligibilityStatus,
  E2eePolicyFacts
} from '@/e2ee/e2ee-policy';

const CALLER = 'caller';

function facts(overrides: Partial<E2eePolicyFacts> = {}): E2eePolicyFacts {
  return {
    profileId: 'target',
    directMessagePolicy: ProfileDirectMessagePolicy.EVERYONE,
    followsCaller: false,
    blocked: false,
    activeDevices: 1,
    ...overrides
  };
}

function decide(overrides: Partial<E2eePolicyFacts>, bypass = false) {
  return decideE2eePolicy({
    callerProfileId: CALLER,
    facts: facts(overrides),
    bypass
  });
}

describe('decideE2eePolicy', () => {
  it('applies the DM policy', () => {
    expect(decide({})).toBe(E2eeEligibilityStatus.OK);
    expect(
      decide({ directMessagePolicy: ProfileDirectMessagePolicy.NOBODY })
    ).toBe(E2eeEligibilityStatus.POLICY);
    expect(
      decide({
        directMessagePolicy: ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW
      })
    ).toBe(E2eeEligibilityStatus.POLICY);
    expect(
      decide({
        directMessagePolicy: ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW,
        followsCaller: true
      })
    ).toBe(E2eeEligibilityStatus.OK);
  });

  it('checks blocks before policy and devices last', () => {
    expect(
      decide({
        blocked: true,
        directMessagePolicy: ProfileDirectMessagePolicy.NOBODY,
        activeDevices: 0
      })
    ).toBe(E2eeEligibilityStatus.BLOCKED);
    expect(
      decide({
        directMessagePolicy: ProfileDirectMessagePolicy.NOBODY,
        activeDevices: 0
      })
    ).toBe(E2eeEligibilityStatus.POLICY);
    expect(decide({ activeDevices: 0 })).toBe(E2eeEligibilityStatus.NO_DEVICES);
  });

  it('lets group members and the caller bypass blocks and policy, never devices', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.values(ProfileDirectMessagePolicy)),
        fc.boolean(),
        fc.boolean(),
        fc.nat({ max: 3 }),
        fc.boolean(),
        (directMessagePolicy, followsCaller, blocked, activeDevices, self) => {
          const input = {
            directMessagePolicy,
            followsCaller,
            blocked,
            activeDevices,
            profileId: self ? CALLER : 'target'
          };
          const expected =
            activeDevices > 0
              ? E2eeEligibilityStatus.OK
              : E2eeEligibilityStatus.NO_DEVICES;
          expect(decide(input, true)).toBe(expected);
          if (self) expect(decide(input, false)).toBe(expected);
        }
      )
    );
  });
});
