import { BadRequestException } from '@/exceptions';
import { SqlExecutor } from '@/sql-executor';
import { ModerationReviewDb } from './moderation-review.db';

function createDb() {
  const execute = jest.fn().mockResolvedValue([]);
  const oneOrNull = jest.fn().mockResolvedValue({ count: '2' });
  return {
    execute,
    oneOrNull,
    db: new ModerationReviewDb(
      () => ({ execute, oneOrNull }) as unknown as SqlExecutor
    )
  };
}

describe('manual review case repository', () => {
  it('uses the same subject grouping for case counts and the paged queue', async () => {
    const { db, execute, oneOrNull } = createDb();
    expect(await db.countReviewCases()).toBe(2);
    await db.listReviewCases({ limit: 1 });
    const countSql = oneOrNull.mock.calls[0][0];
    const pageSql = execute.mock.calls[0][0];
    expect(countSql).toContain('count(distinct case_id)');
    expect(pageSql).toContain('group by case_id');
    for (const sql of [countSql, pageSql]) {
      expect(sql).toContain("review_status='NEEDS_REVIEW'");
      expect(sql).toContain("outcome<>'PENDING'");
      expect(sql).toContain("where status='OPEN'");
      expect(sql).toContain('coalesce(published_subject_id, subject_id)');
    }
  });
  it.each(['bad', '1.not-a-hash', `9007199254740999.${'a'.repeat(64)}`])(
    'rejects malformed cursor %s before querying',
    async (before) => {
      const { db, execute } = createDb();
      await expect(
        db.listReviewCases({ limit: 1, before })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(execute).not.toHaveBeenCalled();
    }
  );
  it('uses a stable timestamp and opaque ID cursor after grouping, and normalizes MySQL values', async () => {
    const { db, execute } = createDb();
    execute.mockResolvedValue([
      {
        id: 'b'.repeat(64),
        subject_type: 'DROP',
        created_at: '100',
        open_report_count: '3',
        pending_check_count: '2',
        drop_deleted: 1
      },
      {
        id: 'a'.repeat(64),
        subject_type: 'DROP',
        created_at: '100',
        open_report_count: '1',
        pending_check_count: '0',
        drop_deleted: 0
      }
    ]);
    const page = await db.listReviewCases({
      limit: 1,
      before: `101.${'f'.repeat(64)}`
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      open_report_count: 3,
      pending_check_count: 2,
      drop_deleted: true,
      created_at: 100
    });
    expect(page.next_cursor).toBe(`100.${'b'.repeat(64)}`);
    expect(execute.mock.calls[0][1]).toMatchObject({
      beforeTime: 101,
      beforeId: 'f'.repeat(64),
      limit: 2
    });
  });
});
