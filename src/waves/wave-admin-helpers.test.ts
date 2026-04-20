import { isWaveCreatorOrAdmin } from './wave-admin.helpers';

describe('isWaveCreatorOrAdmin', () => {
  it('counts wave creators as admins even without admin group membership', () => {
    expect(
      isWaveCreatorOrAdmin({
        authenticatedProfileId: 'creator',
        wave: {
          created_by: 'creator',
          admin_group_id: 'admin-group'
        },
        groupIdsUserIsEligibleFor: []
      })
    ).toBe(true);
  });

  it('counts admin group members as admins', () => {
    expect(
      isWaveCreatorOrAdmin({
        authenticatedProfileId: 'admin',
        wave: {
          created_by: 'creator',
          admin_group_id: 'admin-group'
        },
        groupIdsUserIsEligibleFor: ['admin-group']
      })
    ).toBe(true);
  });

  it('rejects users who are neither creator nor admin group member', () => {
    expect(
      isWaveCreatorOrAdmin({
        authenticatedProfileId: 'outsider',
        wave: {
          created_by: 'creator',
          admin_group_id: 'admin-group'
        },
        groupIdsUserIsEligibleFor: []
      })
    ).toBe(false);
  });
});
