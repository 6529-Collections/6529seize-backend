import { IdentityNotificationEntity } from '@/entities/IIdentityNotification';
import { IdentityPushNotificationAccess } from './identity-push-notification-access';

describe('IdentityPushNotificationAccess', () => {
  function createNotification(
    overrides: Partial<IdentityNotificationEntity> = {}
  ): IdentityNotificationEntity {
    return {
      id: 1,
      identity_id: 'recipient-1',
      additional_identity_id: 'actor-1',
      related_drop_id: 'drop-1',
      related_drop_part_no: null,
      related_drop_2_id: null,
      related_drop_2_part_no: null,
      cause: 'IDENTITY_MENTIONED',
      additional_data: '{}',
      created_at: 1,
      read_at: null,
      visibility_group_id: 'private-group',
      wave_id: 'wave-1',
      ...overrides
    } as IdentityNotificationEntity;
  }

  function createAccess({
    eligibleGroupIds = ['private-group'],
    visibleWaves = [{ id: 'wave-1' }],
    relatedDrops = [{ id: 'drop-1', wave_id: 'wave-1' }]
  }: {
    eligibleGroupIds?: string[];
    visibleWaves?: Array<{ id: string }>;
    relatedDrops?: Array<{ id: string; wave_id: string }>;
  } = {}) {
    const groupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(eligibleGroupIds)
    };
    const wavesDb = {
      findWavesByIds: jest.fn().mockResolvedValue(visibleWaves)
    };
    const dropRepository = {
      findBy: jest.fn().mockResolvedValue(relatedDrops)
    };
    const dataSourceSupplier = jest.fn(() => ({
      getRepository: jest.fn(() => dropRepository)
    }));
    return {
      access: new IdentityPushNotificationAccess(
        groupsService as any,
        wavesDb as any,
        dataSourceSupplier as any
      ),
      groupsService,
      wavesDb,
      dropRepository,
      dataSourceSupplier
    };
  }

  it('allows notifications without wave-scoped content', async () => {
    const { access, groupsService, wavesDb, dataSourceSupplier } =
      createAccess();

    await expect(
      access.canRecipientReadRelatedContent(
        createNotification({
          wave_id: null,
          visibility_group_id: null,
          related_drop_id: null
        })
      )
    ).resolves.toBe(true);

    expect(groupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
    expect(wavesDb.findWavesByIds).not.toHaveBeenCalled();
    expect(dataSourceSupplier).not.toHaveBeenCalled();
  });

  it('denies a notification when the recipient cannot read its wave', async () => {
    const { access, wavesDb, dataSourceSupplier } = createAccess({
      eligibleGroupIds: [],
      visibleWaves: []
    });

    await expect(
      access.canRecipientReadRelatedContent(createNotification())
    ).resolves.toBe(false);

    expect(wavesDb.findWavesByIds).toHaveBeenCalledWith(['wave-1'], []);
    expect(dataSourceSupplier).not.toHaveBeenCalled();
  });

  it('allows related drops only when they belong to the visible wave', async () => {
    const { access } = createAccess({
      relatedDrops: [
        { id: 'drop-1', wave_id: 'wave-1' },
        { id: 'drop-2', wave_id: 'wave-1' }
      ]
    });

    await expect(
      access.canRecipientReadRelatedContent(
        createNotification({ related_drop_2_id: 'drop-2' })
      )
    ).resolves.toBe(true);
  });

  it('denies related content from a different wave', async () => {
    const { access } = createAccess({
      relatedDrops: [{ id: 'drop-1', wave_id: 'private-wave-2' }]
    });

    await expect(
      access.canRecipientReadRelatedContent(createNotification())
    ).resolves.toBe(false);
  });

  it('denies a notification when a related drop no longer exists', async () => {
    const { access } = createAccess({ relatedDrops: [] });

    await expect(
      access.canRecipientReadRelatedContent(createNotification())
    ).resolves.toBe(false);
  });
});
