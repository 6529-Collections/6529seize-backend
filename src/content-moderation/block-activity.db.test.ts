import 'reflect-metadata';
import { CONTENT_MODERATION_AUDIT_LOG_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ContentModerationDb } from './content-moderation.db';

const block = {
  actor_profile_id: 'actor-1',
  target_profile_id: 'target-1',
  created_at: 500,
  action: 'PROFILE_BLOCKED',
  previous_state: 'UNBLOCKED',
  new_state: 'BLOCKED'
};
const unblock = {
  ...block,
  action: 'PROFILE_UNBLOCKED',
  previous_state: 'BLOCKED',
  new_state: 'UNBLOCKED'
};

describeWithSeed(
  'Block activity history',
  {
    table: CONTENT_MODERATION_AUDIT_LOG_TABLE,
    rows: [
      { ...block, id: '9' },
      { ...unblock, id: '100' },
      { ...block, id: '101' },
      { ...unblock, id: '102', new_state: 'BLOCKED' },
      { ...block, id: '103', action: 'PROFILE_SUSPENDED' },
      { ...unblock, id: '104', actor_profile_id: null },
      { ...unblock, id: '105', target_profile_id: null },
      { ...unblock, id: '110', created_at: 400 }
    ]
  },
  () => {
    const db = new ContentModerationDb(() => sqlExecutor);

    it.each([undefined, false])(
      'keeps block-only clients compatible (%s)',
      async (include_unblocks) => {
        const rows = await db.getBlockActivity({ limit: 10, include_unblocks });
        expect(
          rows.map(({ id, action }) => ({ id: String(id), action }))
        ).toEqual([
          { id: '101', action: 'PROFILE_BLOCKED' },
          { id: '9', action: 'PROFILE_BLOCKED' }
        ]);
      }
    );

    it('paginates both transition types by timestamp and numeric audit ID without duplicates', async () => {
      const first = await db.getBlockActivity({
        limit: 2,
        include_unblocks: true
      });
      expect(first.map(({ action }) => action)).toEqual([
        'PROFILE_BLOCKED',
        'PROFILE_UNBLOCKED'
      ]);
      expect(first[1]?.cursor).toBe('500.100');

      const second = await db.getBlockActivity({
        limit: 2,
        include_unblocks: true,
        before: first[1]?.cursor
      });
      expect([...first, ...second].map(({ id }) => String(id))).toEqual([
        '101',
        '100',
        '9',
        '110'
      ]);
      expect(second[1]).toMatchObject({
        action: 'PROFILE_UNBLOCKED',
        created_at: 400,
        blocker_profile_id: 'actor-1',
        blocked_profile_id: 'target-1',
        blocker_handle: null,
        blocked_handle: null
      });
      await expect(
        db.getBlockActivity({
          limit: 2,
          include_unblocks: true,
          before: second[1]?.cursor
        })
      ).resolves.toEqual([]);
    });
  }
);
