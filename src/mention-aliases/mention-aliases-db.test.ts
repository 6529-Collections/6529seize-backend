import 'reflect-metadata';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { MentionAliasesDb } from './mention-aliases.db';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  anIdentity,
  aRandomIdentityKey,
  withIdentities
} from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';

describe('MentionAliasesDb', () => {
  it('only returns alias members that have renderable handles', async () => {
    const executor = {
      execute: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'alias-1', alias: 'frens' }])
        .mockResolvedValueOnce([])
    };
    const db = new MentionAliasesDb(() => executor as never);

    await expect(db.findByOwner('owner-1')).resolves.toEqual([
      { id: 'alias-1', alias: 'frens', members: [] }
    ]);
    expect(executor.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('and i.handle is not null'),
      { aliasIds: ['alias-1'] },
      undefined
    );
  });

  it('only validates profiles that have renderable handles', async () => {
    const connection = { connection: {} } as ConnectionWrapper<any>;
    const executor = {
      execute: jest.fn().mockResolvedValue([{ profile_id: 'profile-1' }])
    };
    const db = new MentionAliasesDb(() => executor as never);

    await expect(
      db.findMentionableProfileIds(['profile-1'], connection)
    ).resolves.toEqual(['profile-1']);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('and handle is not null'),
      { profileIds: ['profile-1'] },
      { wrappedConnection: connection }
    );
  });

  it('preserves target members and fills remaining capacity from a conflicting source alias', async () => {
    const connection = { connection: {} } as ConnectionWrapper<any>;
    const targetMembers = Array.from({ length: 24 }, (_, index) => ({
      alias_id: 'target-alias',
      member_profile_id: `target-${index}`
    }));
    const executor = {
      execute: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            source_alias_id: 'source-alias',
            target_alias_id: 'target-alias'
          }
        ])
        .mockResolvedValueOnce([
          ...targetMembers,
          {
            alias_id: 'source-alias',
            member_profile_id: 'target-0'
          },
          {
            alias_id: 'source-alias',
            member_profile_id: 'source-only-1'
          },
          {
            alias_id: 'source-alias',
            member_profile_id: 'source-only-2'
          }
        ])
        .mockResolvedValueOnce([]),
      executeNativeQueriesInTransaction: jest.fn(),
      bulkInsert: jest.fn()
    };
    const db = new MentionAliasesDb(() => executor as never);
    const replaceMembers = jest
      .spyOn(db, 'replaceMembers')
      .mockResolvedValue(undefined);
    const deleteAlias = jest
      .spyOn(db, 'deleteAlias')
      .mockResolvedValue(undefined);

    await db.mergeProfileIds('source-profile', 'target-profile', connection);

    expect(executor.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('join mention_alias_members source_member'),
      { sourceProfileId: 'source-profile' },
      { wrappedConnection: connection }
    );

    expect(replaceMembers).toHaveBeenCalledWith(
      'target-alias',
      [
        ...targetMembers.map((member) => member.member_profile_id),
        'source-only-1'
      ],
      connection
    );
    expect(deleteAlias).toHaveBeenCalledWith('source-alias', connection);
    const retainedMemberIds = replaceMembers.mock.calls[0]?.[1] ?? [];
    expect(retainedMemberIds).toHaveLength(25);
    expect(retainedMemberIds).not.toContain('source-only-2');
  });

  it('repoints members without duplicate profiles, positions, or cap overflow', async () => {
    const connection = { connection: {} } as ConnectionWrapper<any>;
    const fullAliasMembers = [
      {
        alias_id: 'full-alias',
        member_profile_id: 'source-profile'
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        alias_id: 'full-alias',
        member_profile_id: `member-${index}`
      }))
    ];
    const executor = {
      execute: jest
        .fn()
        .mockResolvedValueOnce([
          {
            alias_id: 'dedupe-alias',
            member_profile_id: 'source-profile'
          },
          {
            alias_id: 'dedupe-alias',
            member_profile_id: 'target-profile'
          },
          ...fullAliasMembers
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      executeNativeQueriesInTransaction: jest.fn(),
      bulkInsert: jest.fn().mockResolvedValue(undefined)
    };
    const db = new MentionAliasesDb(() => executor as never);

    await db.mergeProfileIds('source-profile', 'target-profile', connection);

    expect(executor.bulkInsert).toHaveBeenNthCalledWith(
      1,
      'mention_alias_members',
      [
        {
          alias_id: 'dedupe-alias',
          member_profile_id: 'target-profile',
          position: 0
        }
      ],
      ['alias_id', 'member_profile_id', 'position'],
      undefined,
      { connection }
    );
    const fullAliasRows = executor.bulkInsert.mock.calls[1]?.[1] ?? [];
    expect(fullAliasRows).toHaveLength(25);
    expect(fullAliasRows[0]).toEqual({
      alias_id: 'full-alias',
      member_profile_id: 'target-profile',
      position: 0
    });
    expect(
      fullAliasRows.map((row: { position: number }) => row.position)
    ).toEqual(Array.from({ length: 25 }, (_, index) => index));
    expect(
      new Set(
        fullAliasRows.map(
          (row: { member_profile_id: string }) => row.member_profile_id
        )
      ).size
    ).toBe(25);
  });
});

const lockOwnerIdentityKey = aRandomIdentityKey();
const lockOwnerIdentity = anIdentity({}, lockOwnerIdentityKey);
const lockOwnerProfile = aProfile({
  external_id: lockOwnerIdentityKey.profile_id,
  handle: lockOwnerIdentityKey.handle,
  primary_wallet: lockOwnerIdentityKey.primary_address
});

describeWithSeed(
  'MentionAliasesDb lockOwnerProfile',
  [withIdentities([lockOwnerIdentity]), withProfiles([lockOwnerProfile])],
  () => {
    const db = new MentionAliasesDb(() => sqlExecutor);

    it('locks the profile addressed by the authenticated identity profile id', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await expect(
            db.lockOwnerProfile(lockOwnerIdentityKey.profile_id, connection)
          ).resolves.toBe(true);
        }
      );
    });
  }
);
