import * as fc from 'fast-check';
import {
  DirectMessageAdmission,
  DirectMessageRefusalReason
} from '@/direct-messages/direct-message-admission';
import { decideE2eeEligibility, E2eeEligibilityStatus } from './e2ee-policy';

const ALLOWED: DirectMessageAdmission = {
  allowed: true,
  recipientProfileId: 'target'
};

function refused(reason: DirectMessageRefusalReason): DirectMessageAdmission {
  return {
    allowed: false,
    recipientProfileId: 'target',
    recipientHandle: 'target',
    reason,
    publicGroup: null
  };
}

describe('decideE2eeEligibility', () => {
  it('is OK when admitted and the target has devices', () => {
    expect(
      decideE2eeEligibility({ admission: ALLOWED, activeDevices: 2 })
    ).toEqual({ status: E2eeEligibilityStatus.OK, reason: null });
  });

  it('is NO_DEVICES when admitted without devices', () => {
    expect(
      decideE2eeEligibility({ admission: ALLOWED, activeDevices: 0 })
    ).toEqual({ status: E2eeEligibilityStatus.NO_DEVICES, reason: null });
  });

  it.each([
    DirectMessageRefusalReason.NOT_ACCEPTING,
    DirectMessageRefusalReason.PEOPLE_I_FOLLOW_ONLY,
    DirectMessageRefusalReason.GROUP_MEMBERS_ONLY
  ])('maps a %s refusal to POLICY with its reason', (reason) => {
    expect(
      decideE2eeEligibility({ admission: refused(reason), activeDevices: 1 })
    ).toEqual({ status: E2eeEligibilityStatus.POLICY, reason });
  });

  it('reports BLOCKED only for the caller own block', () => {
    expect(
      decideE2eeEligibility({
        admission: refused(DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT),
        activeDevices: 1
      })
    ).toEqual({
      status: E2eeEligibilityStatus.BLOCKED,
      reason: DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT
    });
  });

  it('skips admission for a bypassing profile (null admission)', () => {
    expect(
      decideE2eeEligibility({ admission: null, activeDevices: 1 }).status
    ).toBe(E2eeEligibilityStatus.OK);
  });

  it('never returns BLOCKED unless the refusal is the caller own block (property)', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.constantFrom(...Object.values(DirectMessageRefusalReason)),
          { nil: null }
        ),
        fc.nat(5),
        (reason, activeDevices) => {
          const decision = decideE2eeEligibility({
            admission: reason === null ? ALLOWED : refused(reason),
            activeDevices
          });
          expect(decision.status === E2eeEligibilityStatus.BLOCKED).toBe(
            reason === DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT
          );
          if (reason !== null) {
            expect([
              E2eeEligibilityStatus.POLICY,
              E2eeEligibilityStatus.BLOCKED
            ]).toContain(decision.status);
          }
        }
      )
    );
  });
});
