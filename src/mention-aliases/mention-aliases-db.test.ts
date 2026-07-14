import { ConnectionWrapper } from '@/sql-executor';
import { MentionAliasesDb } from './mention-aliases.db';

describe('MentionAliasesDb', () => {
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
});
