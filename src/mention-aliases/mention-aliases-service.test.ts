import { BadRequestException, NotFoundException } from '@/exceptions';
import { MentionAliasesService } from './mention-aliases.service';

function createDb() {
  const connection = {};
  return {
    connection,
    db: {
      executeNativeQueriesInTransaction: jest.fn(async (fn) => fn(connection)),
      findByOwner: jest.fn(),
      lockOwnerProfile: jest.fn().mockResolvedValue(undefined),
      countByOwner: jest.fn().mockResolvedValue(0),
      normalizedAliasExists: jest.fn().mockResolvedValue(false),
      findExistingProfileIds: jest.fn().mockResolvedValue(['profile-2']),
      insertAlias: jest.fn().mockResolvedValue(undefined),
      replaceMembers: jest.fn().mockResolvedValue(undefined),
      findOwnedAlias: jest
        .fn()
        .mockResolvedValue({ id: 'alias-1', alias: 'old' }),
      updateAliasName: jest.fn().mockResolvedValue(undefined),
      deleteAlias: jest.fn().mockResolvedValue(undefined)
    }
  };
}

describe('MentionAliasesService', () => {
  it('creates a normalized personal shortcut', async () => {
    const { db, connection } = createDb();
    db.findByOwner.mockResolvedValue([
      {
        id: expect.any(String),
        alias: 'frens',
        members: [{ profile_id: 'profile-2', handle: 'alice', pfp: null }]
      }
    ]);
    db.insertAlias.mockImplementation(async ({ id }) => {
      db.findByOwner.mockResolvedValue([
        {
          id,
          alias: 'frens',
          members: [{ profile_id: 'profile-2', handle: 'alice', pfp: null }]
        }
      ]);
    });
    const service = new MentionAliasesService(db as any);

    await expect(
      service.create('owner-1', {
        alias: '@FrEnS',
        member_profile_ids: ['profile-2', 'profile-2']
      })
    ).resolves.toEqual(
      expect.objectContaining({ alias: 'frens', members: [expect.any(Object)] })
    );

    expect(db.insertAlias).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerProfileId: 'owner-1',
        alias: 'frens',
        normalizedAlias: 'frens'
      }),
      connection
    );
    expect(db.lockOwnerProfile).toHaveBeenCalledWith('owner-1', connection);
    expect(db.replaceMembers).toHaveBeenCalledWith(
      expect.any(String),
      ['profile-2'],
      connection
    );
  });

  it.each(['@ALL', 'Everyone', 'ADMINS', 'team', '6529DEVS', 'devs6529'])(
    'rejects reserved shortcut %s',
    async (alias) => {
      const { db } = createDb();
      const service = new MentionAliasesService(db as any);

      await expect(
        service.create('owner-1', {
          alias,
          member_profile_ids: ['profile-2']
        })
      ).rejects.toThrow(BadRequestException);
    }
  );

  it('rejects a case-insensitive duplicate', async () => {
    const { db } = createDb();
    db.normalizedAliasExists.mockResolvedValue(true);
    const service = new MentionAliasesService(db as any);

    await expect(
      service.create('owner-1', {
        alias: 'Frens',
        member_profile_ids: ['profile-2']
      })
    ).rejects.toThrow('You already have a @frens mention shortcut.');
  });

  it('translates a concurrent duplicate insert into a bad request', async () => {
    const { db } = createDb();
    db.insertAlias.mockRejectedValue({ code: 'ER_DUP_ENTRY' });
    const service = new MentionAliasesService(db as any);

    await expect(
      service.create('owner-1', {
        alias: 'frens',
        member_profile_ids: ['profile-2']
      })
    ).rejects.toThrow('You already have a @frens mention shortcut.');
  });

  it('rejects updating an alias owned by another profile', async () => {
    const { db } = createDb();
    db.findOwnedAlias.mockResolvedValue(null);
    const service = new MentionAliasesService(db as any);

    await expect(
      service.update('owner-1', 'alias-1', {
        alias: 'frens',
        member_profile_ids: ['profile-2']
      })
    ).rejects.toThrow(NotFoundException);
  });
});
