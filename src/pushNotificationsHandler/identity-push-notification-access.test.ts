import {
  IdentityNotificationCause,
  IdentityNotificationEntity
} from '@/entities/IIdentityNotification';
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
      find: jest.fn().mockResolvedValue(relatedDrops)
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

  it('allows a public wave without eligible groups', async () => {
    const { access, groupsService, wavesDb } = createAccess({
      eligibleGroupIds: [],
      visibleWaves: [{ id: 'public-wave' }],
      relatedDrops: [{ id: 'drop-1', wave_id: 'public-wave' }]
    });

    await expect(
      access.canRecipientReadRelatedContent(
        createNotification({
          wave_id: 'public-wave',
          visibility_group_id: null
        })
      )
    ).resolves.toBe(true);

    expect(groupsService.getGroupsUserIsEligibleFor).toHaveBeenCalledWith(
      'recipient-1'
    );
    expect(wavesDb.findWavesByIds).toHaveBeenCalledWith(['public-wave'], []);
  });

  it('caches wave eligibility while checking multiple notifications in one batch', async () => {
    const { access, groupsService, wavesDb } = createAccess();
    const waveAccessCache = new Map<string, Promise<boolean>>();

    await expect(
      access.canRecipientReadRelatedContent(
        createNotification(),
        waveAccessCache
      )
    ).resolves.toBe(true);
    await expect(
      access.canRecipientReadRelatedContent(
        createNotification({ related_drop_id: 'drop-1' }),
        waveAccessCache
      )
    ).resolves.toBe(true);

    expect(groupsService.getGroupsUserIsEligibleFor).toHaveBeenCalledTimes(1);
    expect(wavesDb.findWavesByIds).toHaveBeenCalledTimes(1);
  });

  it('allows the primary drop when a cross-wave secondary drop is referenced', async () => {
    const { access } = createAccess({
      relatedDrops: [{ id: 'drop-1', wave_id: 'wave-1' }]
    });

    await expect(
      access.canRecipientReadRelatedContent(
        createNotification({
          cause: IdentityNotificationCause.DROP_QUOTED,
          related_drop_2_id: 'private-wave-2-drop'
        })
      )
    ).resolves.toBe(true);
  });

  it('denies primary related content from a different wave', async () => {
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
