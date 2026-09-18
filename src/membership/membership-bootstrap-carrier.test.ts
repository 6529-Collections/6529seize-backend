import {
  handleMembershipBootstrapAction,
  membershipBootstrapAction
} from './membership-bootstrap-carrier';

describe('Membership bootstrap carrier admission', () => {
  it('accepts only closed operator actions and rejects extra controls', () => {
    expect(
      membershipBootstrapAction({
        operator_action: 'membership_bootstrap_advance_v1'
      })
    ).toEqual({ operator_action: 'membership_bootstrap_advance_v1' });
    expect(
      membershipBootstrapAction({ operator_action: 'arbitrary' })
    ).toBeNull();
    expect(() =>
      membershipBootstrapAction({
        operator_action: 'membership_backfill_start_v1',
        target_id: 'another-profile'
      })
    ).toThrow('Invalid membership operator action');
    expect(() =>
      membershipBootstrapAction({
        operator_action: 'membership_bootstrap_record_writers_v1',
        tracked_writer_receipt: null
      })
    ).toThrow('Invalid membership writer receipt action');
  });

  it('rejects production before loading a database', async () => {
    const action = membershipBootstrapAction({
      operator_action: 'membership_bootstrap_prepare_v1'
    });
    expect(action).not.toBeNull();
    await expect(
      handleMembershipBootstrapAction(
        action!,
        { awsRequestId: 'request', getRemainingTimeInMillis: () => 900000 },
        { stage: 'prod', region: 'us-east-1' }
      )
    ).rejects.toThrow('staging only');
  });
});
