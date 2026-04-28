import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { WaveType } from '@/entities/IWave';
import { CurationsApiService } from './curations.api.service';

describe('CurationsApiService', () => {
  function createService({
    wave = {
      id: 'wave-1',
      type: WaveType.CHAT,
      created_by: 'profile-1',
      admin_group_id: null
    },
    drop = {
      id: 'drop-1',
      wave_id: 'wave-1',
      drop_type: DropType.CHAT
    },
    eligibleGroupIds = ['community-group-1'],
    authenticationContext = AuthenticationContext.fromProfileId('profile-1'),
    communityGroup = { id: 'community-group-1', is_private: false },
    curatedCurationIds = [],
    dropCurations,
    waveCurations = [
      {
        id: 'curation-1',
        wave_id: 'wave-1',
        community_group_id: 'community-group-1',
        name: 'Featured',
        created_at: 1,
        updated_at: 1,
        priority_order: 1
      }
    ]
  }: {
    wave?: Record<string, unknown> | null;
    drop?: Record<string, unknown> | null;
    eligibleGroupIds?: string[];
    authenticationContext?: AuthenticationContext;
    communityGroup?: { id: string; is_private: boolean } | null;
    curatedCurationIds?: string[];
    dropCurations?: Record<string, unknown>[];
    waveCurations?: Record<string, unknown>[];
  } = {}) {
    const connection = { id: 'tx' } as any;
    const storedWaveCurations = waveCurations.map((curation) => ({
      ...curation
    }));
    const storedDropCurations = (
      dropCurations ??
      curatedCurationIds.map((curationId, index) => ({
        drop_id: 'drop-1',
        curation_id: curationId,
        curated_by: 'profile-1',
        created_at: index + 1,
        updated_at: index + 1,
        wave_id: 'wave-1',
        priority_order: index + 1
      }))
    ).map((curation) => ({ ...curation }));
    const getSortedWaveCurations = () =>
      [...storedWaveCurations].sort((a, b) => {
        const aPriority =
          (a.priority_order as number | null) ?? Number.MAX_SAFE_INTEGER;
        const bPriority =
          (b.priority_order as number | null) ?? Number.MAX_SAFE_INTEGER;
        return (
          aPriority - bPriority ||
          (a.created_at as number) - (b.created_at as number) ||
          String(a.id).localeCompare(String(b.id))
        );
      });
    const getSortedDropCurations = (curationId: string) =>
      [...storedDropCurations]
        .filter((curation) => curation.curation_id === curationId)
        .sort((a, b) => {
          const aPriority =
            (a.priority_order as number | null) ?? Number.MAX_SAFE_INTEGER;
          const bPriority =
            (b.priority_order as number | null) ?? Number.MAX_SAFE_INTEGER;
          return (
            aPriority - bPriority ||
            (a.created_at as number) - (b.created_at as number) ||
            String(a.drop_id).localeCompare(String(b.drop_id))
          );
        });
    const curationsDb = {
      executeNativeQueriesInTransaction: jest.fn(async (fn) => fn(connection)),
      findCommunityGroupById: jest.fn().mockResolvedValue(communityGroup),
      findWaveCurationById: jest
        .fn()
        .mockImplementation(
          async ({ id }) =>
            storedWaveCurations.find((curation) => curation.id === id) ?? null
        ),
      lockWaveCurationById: jest
        .fn()
        .mockImplementation(
          async ({ id }) =>
            storedWaveCurations.find((curation) => curation.id === id) ?? null
        ),
      findWaveCurationByName: jest.fn().mockResolvedValue(null),
      insertWaveCuration: jest.fn().mockImplementation(async (entity) => {
        storedWaveCurations.push({ ...entity });
      }),
      updateWaveCuration: jest.fn().mockImplementation(async (param) => {
        const target = storedWaveCurations.find(
          (curation) => curation.id === param.id
        );
        if (target) {
          Object.assign(target, {
            name: param.name,
            community_group_id: param.community_group_id,
            updated_at: param.updated_at,
            priority_order: param.priority_order
          });
        }
      }),
      lockWaveCurationsByWaveId: jest
        .fn()
        .mockImplementation(async () => getSortedWaveCurations()),
      incrementWaveCurationPriorityOrderRange: jest
        .fn()
        .mockImplementation(
          async ({ from_priority_order, to_priority_order }) => {
            for (const curation of storedWaveCurations) {
              const priorityOrder = curation.priority_order as number | null;
              if (
                priorityOrder !== null &&
                priorityOrder >= from_priority_order &&
                (to_priority_order === undefined ||
                  priorityOrder <= to_priority_order)
              ) {
                curation.priority_order = priorityOrder + 1;
              }
            }
          }
        ),
      decrementWaveCurationPriorityOrderRange: jest
        .fn()
        .mockImplementation(
          async ({ from_priority_order, to_priority_order }) => {
            for (const curation of storedWaveCurations) {
              const priorityOrder = curation.priority_order as number | null;
              if (
                priorityOrder !== null &&
                priorityOrder >= from_priority_order &&
                (to_priority_order === undefined ||
                  priorityOrder <= to_priority_order)
              ) {
                curation.priority_order = priorityOrder - 1;
              }
            }
          }
        ),
      findWaveCurationsByWaveId: jest
        .fn()
        .mockImplementation(async () => getSortedWaveCurations()),
      findDropCurationsForDropId: jest
        .fn()
        .mockImplementation(async (dropId) =>
          storedDropCurations.filter((curation) => curation.drop_id === dropId)
        ),
      lockDropCurationsByCurationId: jest
        .fn()
        .mockImplementation(async (curationId) =>
          getSortedDropCurations(curationId)
        ),
      incrementDropCurationPriorityOrderRange: jest
        .fn()
        .mockImplementation(
          async ({ curation_id, from_priority_order, to_priority_order }) => {
            for (const curation of storedDropCurations) {
              const priorityOrder = curation.priority_order as number | null;
              if (
                curation.curation_id === curation_id &&
                priorityOrder !== null &&
                priorityOrder >= from_priority_order &&
                (to_priority_order === undefined ||
                  priorityOrder <= to_priority_order)
              ) {
                curation.priority_order = priorityOrder + 1;
              }
            }
          }
        ),
      decrementDropCurationPriorityOrderRange: jest
        .fn()
        .mockImplementation(
          async ({ curation_id, from_priority_order, to_priority_order }) => {
            for (const curation of storedDropCurations) {
              const priorityOrder = curation.priority_order as number | null;
              if (
                curation.curation_id === curation_id &&
                priorityOrder !== null &&
                priorityOrder >= from_priority_order &&
                (to_priority_order === undefined ||
                  priorityOrder <= to_priority_order)
              ) {
                curation.priority_order = priorityOrder - 1;
              }
            }
          }
        ),
      upsertDropCuration: jest.fn().mockImplementation(async (param) => {
        const target = storedDropCurations.find(
          (curation) =>
            curation.drop_id === param.drop_id &&
            curation.curation_id === param.curation_id
        );
        if (target) {
          Object.assign(target, {
            curated_by: param.curated_by,
            updated_at: 2,
            priority_order: param.priority_order
          });
        } else {
          storedDropCurations.push({
            ...param,
            created_at: 1,
            updated_at: 1
          });
        }
      }),
      updateDropCuration: jest.fn().mockImplementation(async (param) => {
        const target = storedDropCurations.find(
          (curation) =>
            curation.drop_id === param.drop_id &&
            curation.curation_id === param.curation_id
        );
        if (target) {
          Object.assign(target, {
            curated_by: param.curated_by,
            updated_at: param.updated_at,
            priority_order: param.priority_order
          });
        }
      }),
      deleteDropCuration: jest.fn().mockImplementation(async (param) => {
        const targetIndex = storedDropCurations.findIndex(
          (curation) =>
            curation.drop_id === param.drop_id &&
            curation.curation_id === param.curation_id
        );
        if (targetIndex !== -1) {
          storedDropCurations.splice(targetIndex, 1);
        }
      }),
      deleteDropCurationsByCurationId: jest.fn().mockResolvedValue(undefined),
      deleteWaveCuration: jest.fn().mockImplementation(async ({ id }) => {
        const targetIndex = storedWaveCurations.findIndex(
          (curation) => curation.id === id
        );
        if (targetIndex !== -1) {
          storedWaveCurations.splice(targetIndex, 1);
        }
      })
    };
    const wavesApiDb = {
      findWaveById: jest.fn().mockResolvedValue(wave)
    };
    const dropsDb = {
      findDropById: jest.fn().mockResolvedValue(drop)
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(eligibleGroupIds)
    };
    const profileWavesDb = {
      clearProfileCurationByCurationId: jest.fn().mockResolvedValue(undefined)
    };

    return {
      service: new CurationsApiService(
        curationsDb as any,
        wavesApiDb as any,
        dropsDb as any,
        userGroupsService as any,
        profileWavesDb as any
      ),
      curationsDb,
      profileWavesDb,
      storedWaveCurations,
      storedDropCurations,
      ctx: {
        authenticationContext,
        timer: undefined
      } as any
    };
  }

  it('creates curations for chat waves at max+1 when priority_order is omitted', async () => {
    const { service, curationsDb, ctx } = createService({
      waveCurations: [
        {
          id: 'curation-1',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'Featured',
          created_at: 1,
          updated_at: 1,
          priority_order: 1
        },
        {
          id: 'curation-2',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'Team Picks',
          created_at: 2,
          updated_at: 2,
          priority_order: 2
        }
      ]
    });

    await expect(
      service.createWaveCuration(
        'wave-1',
        {
          name: '  Editor Picks  ',
          group_id: 'community-group-1'
        } as any,
        ctx
      )
    ).resolves.toEqual(
      expect.objectContaining({
        name: 'Editor Picks',
        wave_id: 'wave-1',
        group_id: 'community-group-1',
        priority_order: 3
      })
    );

    expect(
      curationsDb.incrementWaveCurationPriorityOrderRange
    ).not.toHaveBeenCalled();
    expect(curationsDb.insertWaveCuration).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Editor Picks',
        wave_id: 'wave-1',
        community_group_id: 'community-group-1',
        priority_order: 3
      }),
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });

  it('creates curations at an explicit priority and shifts later curations', async () => {
    const { service, curationsDb, ctx } = createService();

    await expect(
      service.createWaveCuration(
        'wave-1',
        {
          name: '  Featured  ',
          group_id: 'community-group-1',
          priority_order: 1
        } as any,
        ctx
      )
    ).resolves.toEqual(
      expect.objectContaining({
        name: 'Featured',
        wave_id: 'wave-1',
        group_id: 'community-group-1',
        priority_order: 1
      })
    );

    expect(
      curationsDb.incrementWaveCurationPriorityOrderRange
    ).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        from_priority_order: 1
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(curationsDb.insertWaveCuration).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Featured',
        wave_id: 'wave-1',
        community_group_id: 'community-group-1',
        priority_order: 1
      }),
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });

  it('allows curations to use the private wave admin group', async () => {
    const { service, curationsDb, ctx } = createService({
      wave: {
        id: 'wave-1',
        type: WaveType.CHAT,
        created_by: 'profile-2',
        admin_group_id: 'admin-group'
      },
      eligibleGroupIds: ['admin-group'],
      communityGroup: { id: 'admin-group', is_private: true },
      waveCurations: []
    });

    await expect(
      service.createWaveCuration(
        'wave-1',
        {
          name: 'Admin Picks',
          group_id: 'admin-group'
        } as any,
        ctx
      )
    ).resolves.toEqual(
      expect.objectContaining({
        name: 'Admin Picks',
        wave_id: 'wave-1',
        group_id: 'admin-group',
        priority_order: 1
      })
    );

    expect(curationsDb.insertWaveCuration).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Admin Picks',
        wave_id: 'wave-1',
        community_group_id: 'admin-group',
        priority_order: 1
      }),
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });

  it('rejects curations that use a non-admin private group', async () => {
    const { service, curationsDb, ctx } = createService({
      communityGroup: { id: 'private-group', is_private: true }
    });

    await expect(
      service.createWaveCuration(
        'wave-1',
        {
          name: 'Private Picks',
          group_id: 'private-group'
        } as any,
        ctx
      )
    ).rejects.toThrow(`Group private-group is private`);

    expect(curationsDb.insertWaveCuration).not.toHaveBeenCalled();
  });

  it('allows chat drops in chat waves to be curated', async () => {
    const { service, curationsDb, ctx } = createService();

    await expect(
      service.addDropCuration(
        'drop-1',
        { curation_id: 'curation-1' } as any,
        ctx
      )
    ).resolves.toBeUndefined();

    expect(curationsDb.upsertDropCuration).toHaveBeenCalledWith(
      {
        drop_id: 'drop-1',
        curation_id: 'curation-1',
        curated_by: 'profile-1',
        wave_id: 'wave-1',
        priority_order: 1
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });

  it('removes drops from an explicitly selected curation', async () => {
    const { service, curationsDb, ctx } = createService({
      dropCurations: [
        {
          drop_id: 'drop-1',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 1,
          updated_at: 1,
          wave_id: 'wave-1',
          priority_order: 1
        }
      ]
    });

    await expect(
      service.removeDropCuration(
        'drop-1',
        { curation_id: 'curation-1' } as any,
        ctx
      )
    ).resolves.toBeUndefined();

    expect(curationsDb.deleteDropCuration).toHaveBeenCalledWith(
      {
        drop_id: 'drop-1',
        curation_id: 'curation-1'
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });

  it('adds a drop at an explicit priority and shifts later drops', async () => {
    const { service, curationsDb, storedDropCurations, ctx } = createService({
      dropCurations: [
        {
          drop_id: 'drop-2',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 2,
          updated_at: 2,
          wave_id: 'wave-1',
          priority_order: 1
        },
        {
          drop_id: 'drop-3',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 3,
          updated_at: 3,
          wave_id: 'wave-1',
          priority_order: 2
        }
      ]
    });

    await service.addDropCuration(
      'drop-1',
      { curation_id: 'curation-1', priority_order: 1 } as any,
      ctx
    );

    expect(
      curationsDb.incrementDropCurationPriorityOrderRange
    ).toHaveBeenCalledWith(
      {
        curation_id: 'curation-1',
        from_priority_order: 1
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(storedDropCurations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ drop_id: 'drop-1', priority_order: 1 }),
        expect.objectContaining({ drop_id: 'drop-2', priority_order: 2 }),
        expect.objectContaining({ drop_id: 'drop-3', priority_order: 3 })
      ])
    );
  });

  it('keeps existing drop priority when adding without priority_order again', async () => {
    const { service, curationsDb, storedDropCurations, ctx } = createService({
      dropCurations: [
        {
          drop_id: 'drop-1',
          curation_id: 'curation-1',
          curated_by: 'profile-2',
          created_at: 1,
          updated_at: 1,
          wave_id: 'wave-1',
          priority_order: 1
        }
      ]
    });

    await service.addDropCuration(
      'drop-1',
      { curation_id: 'curation-1' } as any,
      ctx
    );

    expect(
      curationsDb.incrementDropCurationPriorityOrderRange
    ).not.toHaveBeenCalled();
    expect(
      curationsDb.decrementDropCurationPriorityOrderRange
    ).not.toHaveBeenCalled();
    expect(storedDropCurations).toEqual([
      expect.objectContaining({
        drop_id: 'drop-1',
        curated_by: 'profile-1',
        priority_order: 1
      })
    ]);
  });

  it('moves an existing drop and shifts the displaced range', async () => {
    const { service, curationsDb, storedDropCurations, ctx } = createService({
      dropCurations: [
        {
          drop_id: 'drop-1',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 1,
          updated_at: 1,
          wave_id: 'wave-1',
          priority_order: 1
        },
        {
          drop_id: 'drop-2',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 2,
          updated_at: 2,
          wave_id: 'wave-1',
          priority_order: 2
        },
        {
          drop_id: 'drop-3',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 3,
          updated_at: 3,
          wave_id: 'wave-1',
          priority_order: 3
        }
      ]
    });

    await service.addDropCuration(
      'drop-1',
      { curation_id: 'curation-1', priority_order: 3 } as any,
      ctx
    );

    expect(
      curationsDb.decrementDropCurationPriorityOrderRange
    ).toHaveBeenCalledWith(
      {
        curation_id: 'curation-1',
        from_priority_order: 2,
        to_priority_order: 3
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(storedDropCurations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ drop_id: 'drop-1', priority_order: 3 }),
        expect.objectContaining({ drop_id: 'drop-2', priority_order: 1 }),
        expect.objectContaining({ drop_id: 'drop-3', priority_order: 2 })
      ])
    );
  });

  it('rejects moving an existing drop past the current max priority_order', async () => {
    const { service, curationsDb, storedDropCurations, ctx } = createService({
      dropCurations: [
        {
          drop_id: 'drop-1',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 1,
          updated_at: 1,
          wave_id: 'wave-1',
          priority_order: 1
        },
        {
          drop_id: 'drop-2',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 2,
          updated_at: 2,
          wave_id: 'wave-1',
          priority_order: 2
        },
        {
          drop_id: 'drop-3',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 3,
          updated_at: 3,
          wave_id: 'wave-1',
          priority_order: 3
        }
      ]
    });

    await expect(
      service.addDropCuration(
        'drop-2',
        { curation_id: 'curation-1', priority_order: 4 } as any,
        ctx
      )
    ).rejects.toThrow(`Drop curation priority_order must be between 1 and 3`);

    expect(
      curationsDb.incrementDropCurationPriorityOrderRange
    ).not.toHaveBeenCalled();
    expect(
      curationsDb.decrementDropCurationPriorityOrderRange
    ).not.toHaveBeenCalled();
    expect(storedDropCurations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ drop_id: 'drop-1', priority_order: 1 }),
        expect.objectContaining({ drop_id: 'drop-2', priority_order: 2 }),
        expect.objectContaining({ drop_id: 'drop-3', priority_order: 3 })
      ])
    );
  });

  it('compacts later drop priorities when a drop curation is removed', async () => {
    const { service, curationsDb, storedDropCurations, ctx } = createService({
      dropCurations: [
        {
          drop_id: 'drop-1',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 1,
          updated_at: 1,
          wave_id: 'wave-1',
          priority_order: 1
        },
        {
          drop_id: 'drop-2',
          curation_id: 'curation-1',
          curated_by: 'profile-1',
          created_at: 2,
          updated_at: 2,
          wave_id: 'wave-1',
          priority_order: 2
        }
      ]
    });

    await service.removeDropCuration(
      'drop-1',
      { curation_id: 'curation-1' } as any,
      ctx
    );

    expect(
      curationsDb.decrementDropCurationPriorityOrderRange
    ).toHaveBeenCalledWith(
      {
        curation_id: 'curation-1',
        from_priority_order: 2
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(storedDropCurations).toEqual([
      expect.objectContaining({ drop_id: 'drop-2', priority_order: 1 })
    ]);
  });

  it('rejects out of range drop priority_order values', async () => {
    const { service, ctx } = createService();

    await expect(
      service.addDropCuration(
        'drop-1',
        { curation_id: 'curation-1', priority_order: 2 } as any,
        ctx
      )
    ).rejects.toThrow(`Drop curation priority_order must be between 1 and 1`);
  });

  it('rejects writes when the user is not eligible for the selected curation', async () => {
    const { service, curationsDb, ctx } = createService({
      eligibleGroupIds: []
    });

    await expect(
      service.addDropCuration(
        'drop-1',
        { curation_id: 'curation-1' } as any,
        ctx
      )
    ).rejects.toThrow(`You are not eligible to curate in this curation`);

    expect(curationsDb.upsertDropCuration).not.toHaveBeenCalled();
  });

  it('returns all wave curations for a drop with membership and curator flags', async () => {
    const { service, ctx } = createService({
      eligibleGroupIds: ['community-group-2'],
      curatedCurationIds: ['curation-1'],
      waveCurations: [
        {
          id: 'curation-1',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'Featured',
          created_at: 1,
          updated_at: 1,
          priority_order: 2
        },
        {
          id: 'curation-2',
          wave_id: 'wave-1',
          community_group_id: 'community-group-2',
          name: 'Team Picks',
          created_at: 2,
          updated_at: 2,
          priority_order: 1
        }
      ]
    });

    await expect(service.findDropCurations('drop-1', ctx)).resolves.toEqual([
      expect.objectContaining({
        id: 'curation-2',
        wave_id: 'wave-1',
        group_id: 'community-group-2',
        priority_order: 1,
        drop_included: false,
        drop_priority_order: null,
        authenticated_user_can_curate: true
      }),
      expect.objectContaining({
        id: 'curation-1',
        wave_id: 'wave-1',
        group_id: 'community-group-1',
        priority_order: 2,
        drop_included: true,
        drop_priority_order: 1,
        authenticated_user_can_curate: false
      })
    ]);
  });

  it('returns wave curations ordered by priority_order', async () => {
    const { service, ctx } = createService({
      waveCurations: [
        {
          id: 'curation-1',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'Featured',
          created_at: 1,
          updated_at: 1,
          priority_order: 2
        },
        {
          id: 'curation-2',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'Team Picks',
          created_at: 2,
          updated_at: 2,
          priority_order: 1
        }
      ]
    });

    await expect(service.findWaveCurations('wave-1', ctx)).resolves.toEqual([
      expect.objectContaining({
        id: 'curation-2',
        priority_order: 1
      }),
      expect.objectContaining({
        id: 'curation-1',
        priority_order: 2
      })
    ]);
  });

  it('returns authenticated_user_can_curate as false for unauthenticated callers', async () => {
    const { service, ctx } = createService({
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    await expect(service.findDropCurations('drop-1', ctx)).resolves.toEqual([
      expect.objectContaining({
        id: 'curation-1',
        authenticated_user_can_curate: false
      })
    ]);
  });

  it('returns authenticated_user_can_curate as false for proxy callers', async () => {
    const { service, ctx } = createService({
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: null,
        authenticatedProfileId: 'profile-1',
        roleProfileId: 'profile-2',
        activeProxyActions: [
          {
            id: 'proxy-action-1',
            type: ProfileProxyActionType.READ_WAVE,
            credit_amount: null,
            credit_spent: null
          }
        ]
      }),
      eligibleGroupIds: ['community-group-1']
    });

    await expect(service.findDropCurations('drop-1', ctx)).resolves.toEqual([
      expect.objectContaining({
        id: 'curation-1',
        authenticated_user_can_curate: false
      })
    ]);
  });

  it('deletes persisted memberships when a curation is deleted', async () => {
    const { service, curationsDb, profileWavesDb, storedWaveCurations, ctx } =
      createService({
        waveCurations: [
          {
            id: 'curation-1',
            wave_id: 'wave-1',
            community_group_id: 'community-group-1',
            name: 'Featured',
            created_at: 1,
            updated_at: 1,
            priority_order: 1
          },
          {
            id: 'curation-2',
            wave_id: 'wave-1',
            community_group_id: 'community-group-1',
            name: 'Team Picks',
            created_at: 2,
            updated_at: 2,
            priority_order: 2
          }
        ]
      });

    await expect(
      service.deleteWaveCuration('wave-1', 'curation-1', ctx)
    ).resolves.toBeUndefined();

    expect(curationsDb.deleteDropCurationsByCurationId).toHaveBeenCalledWith(
      'curation-1',
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(
      profileWavesDb.clearProfileCurationByCurationId
    ).toHaveBeenCalledWith(
      'curation-1',
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(
      curationsDb.decrementWaveCurationPriorityOrderRange
    ).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        from_priority_order: 2
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(curationsDb.deleteWaveCuration).toHaveBeenCalledWith(
      {
        id: 'curation-1',
        wave_id: 'wave-1'
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(storedWaveCurations).toEqual([
      expect.objectContaining({
        id: 'curation-2',
        priority_order: 1
      })
    ]);
  });

  it('keeps the current priority_order on update when not provided', async () => {
    const { service, curationsDb, ctx } = createService();

    await service.updateWaveCuration(
      'wave-1',
      'curation-1',
      {
        name: 'Updated',
        group_id: 'community-group-1'
      } as any,
      ctx
    );

    expect(
      curationsDb.incrementWaveCurationPriorityOrderRange
    ).not.toHaveBeenCalled();
    expect(
      curationsDb.decrementWaveCurationPriorityOrderRange
    ).not.toHaveBeenCalled();
    expect(curationsDb.updateWaveCuration).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'curation-1',
        priority_order: 1
      }),
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });

  it('allows updates to use the private wave admin group', async () => {
    const { service, curationsDb, ctx } = createService({
      wave: {
        id: 'wave-1',
        type: WaveType.CHAT,
        created_by: 'profile-2',
        admin_group_id: 'admin-group'
      },
      eligibleGroupIds: ['admin-group'],
      communityGroup: { id: 'admin-group', is_private: true }
    });

    await expect(
      service.updateWaveCuration(
        'wave-1',
        'curation-1',
        {
          name: 'Admin Picks',
          group_id: 'admin-group'
        } as any,
        ctx
      )
    ).resolves.toEqual(
      expect.objectContaining({
        name: 'Admin Picks',
        wave_id: 'wave-1',
        group_id: 'admin-group',
        priority_order: 1
      })
    );

    expect(curationsDb.updateWaveCuration).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'curation-1',
        community_group_id: 'admin-group',
        priority_order: 1
      }),
      expect.objectContaining({
        connection: expect.anything()
      })
    );
  });

  it('moves a curation earlier on update and shifts the displaced range', async () => {
    const { service, curationsDb, storedWaveCurations, ctx } = createService({
      waveCurations: [
        {
          id: 'curation-1',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'A',
          created_at: 1,
          updated_at: 1,
          priority_order: 1
        },
        {
          id: 'curation-2',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'B',
          created_at: 2,
          updated_at: 2,
          priority_order: 2
        },
        {
          id: 'curation-3',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'C',
          created_at: 3,
          updated_at: 3,
          priority_order: 3
        }
      ]
    });

    await service.updateWaveCuration(
      'wave-1',
      'curation-3',
      {
        name: 'C',
        group_id: 'community-group-1',
        priority_order: 1
      } as any,
      ctx
    );

    expect(
      curationsDb.incrementWaveCurationPriorityOrderRange
    ).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        from_priority_order: 1,
        to_priority_order: 2
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(storedWaveCurations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'curation-1', priority_order: 2 }),
        expect.objectContaining({ id: 'curation-2', priority_order: 3 }),
        expect.objectContaining({ id: 'curation-3', priority_order: 1 })
      ])
    );
  });

  it('moves a curation later on update and shifts the displaced range', async () => {
    const { service, curationsDb, storedWaveCurations, ctx } = createService({
      waveCurations: [
        {
          id: 'curation-1',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'A',
          created_at: 1,
          updated_at: 1,
          priority_order: 1
        },
        {
          id: 'curation-2',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'B',
          created_at: 2,
          updated_at: 2,
          priority_order: 2
        },
        {
          id: 'curation-3',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'C',
          created_at: 3,
          updated_at: 3,
          priority_order: 3
        }
      ]
    });

    await service.updateWaveCuration(
      'wave-1',
      'curation-1',
      {
        name: 'A',
        group_id: 'community-group-1',
        priority_order: 3
      } as any,
      ctx
    );

    expect(
      curationsDb.decrementWaveCurationPriorityOrderRange
    ).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        from_priority_order: 2,
        to_priority_order: 3
      },
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(storedWaveCurations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'curation-1', priority_order: 3 }),
        expect.objectContaining({ id: 'curation-2', priority_order: 1 }),
        expect.objectContaining({ id: 'curation-3', priority_order: 2 })
      ])
    );
  });

  it('allows count+1 on update as an alias for move to end', async () => {
    const { service, curationsDb, storedWaveCurations, ctx } = createService({
      waveCurations: [
        {
          id: 'curation-1',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'A',
          created_at: 1,
          updated_at: 1,
          priority_order: 1
        },
        {
          id: 'curation-2',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'B',
          created_at: 2,
          updated_at: 2,
          priority_order: 2
        },
        {
          id: 'curation-3',
          wave_id: 'wave-1',
          community_group_id: 'community-group-1',
          name: 'C',
          created_at: 3,
          updated_at: 3,
          priority_order: 3
        }
      ]
    });

    await service.updateWaveCuration(
      'wave-1',
      'curation-1',
      {
        name: 'A',
        group_id: 'community-group-1',
        priority_order: 4
      } as any,
      ctx
    );

    expect(curationsDb.updateWaveCuration).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'curation-1',
        priority_order: 3
      }),
      expect.objectContaining({
        connection: expect.anything()
      })
    );
    expect(storedWaveCurations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'curation-1', priority_order: 3 }),
        expect.objectContaining({ id: 'curation-2', priority_order: 1 }),
        expect.objectContaining({ id: 'curation-3', priority_order: 2 })
      ])
    );
  });

  it('rejects out of range priority_order values', async () => {
    const { service, ctx } = createService();

    await expect(
      service.createWaveCuration(
        'wave-1',
        {
          name: 'Featured',
          group_id: 'community-group-1',
          priority_order: 3
        } as any,
        ctx
      )
    ).rejects.toThrow(`Curation priority_order must be between 1 and 2`);
  });
});
