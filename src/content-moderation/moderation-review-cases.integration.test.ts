import { randomUUID } from 'node:crypto';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import {
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE
} from '@/constants';
import { ContentModerationDb } from './content-moderation.db';
import { ModerationReviewDb } from './moderation-review.db';
import { ModerationInput } from './moderation-review.types';

const input = (subjectId: string, operation = 'UPDATE'): ModerationInput => ({
  subject_type: 'DROP',
  subject_id: subjectId,
  author_profile_id: 'author',
  actor_profile_id: 'reporter',
  operation,
  policy_family: 'WAVE_CONTENT',
  policy_version: 'test',
  scope: {},
  evidence: { text: operation }
});

describe('unique manual review cases', () => {
  let db: ModerationReviewDb;
  beforeEach(async () => {
    await resetTestDatabase();
    db = new ModerationReviewDb(dbSupplier);
  });
  async function flag(value: ModerationInput, trigger: string) {
    const started = await db.start(value, trigger);
    await db.finish(started.evaluationId, {
      outcome: 'REJECT',
      result: { explanation: 'Requires review' }
    });
    return started;
  }
  it('does not signal manual work while an automated evaluation is still in flight', async () => {
    await db.start(input('in-flight'), 'PUBLIC_FIELD');
    expect(await db.countReviewCases()).toBe(0);
    expect((await db.listReviewCases({ limit: 10 })).items).toEqual([]);
  });
  async function report(dropId: string, itemId: string | null = null) {
    const id = randomUUID();
    await sqlExecutor.execute(
      `insert into ${CONTENT_MODERATION_REPORTS_TABLE}
      (id,item_id,drop_id,reporter_profile_id,author_profile_id,reason,content_snapshot,status,created_at)
      values (:id,:itemId,:dropId,:reporter,'author','OTHER',cast(:snapshot as json),'OPEN',100)`,
      {
        id,
        itemId,
        dropId,
        reporter: randomUUID(),
        snapshot: JSON.stringify({
          wave_id: 'wave',
          parts: [{ content: 'Reported content' }]
        })
      }
    );
    return id;
  }
  it('counts multiple reports and multiple check revisions on a post once, plus a separate category case', async () => {
    const first = await flag(input('post'), 'CONTENT_REPORTED');
    const created = await flag(input('post', 'CREATE'), 'PUBLIC_FIELD');
    await db.attachPublication(created.item.id, 'post', 'revision');
    await report('post', first.item.id);
    await report('post', first.item.id);
    await report('post');
    await flag(
      {
        ...input('Private category text?'),
        subject_type: 'REP_CATEGORY',
        policy_family: 'PUBLIC_FIELDS'
      },
      'PUBLIC_FIELD'
    );
    expect(await db.countReviewCases()).toBe(2);
    expect((await db.counts())?.needs_review).toBe(2);
    const page = await db.listReviewCases({ limit: 10 });
    expect(page.items).toHaveLength(2);
    const post = page.items.find((c) => c.subject_type === 'DROP')!;
    expect(post).toMatchObject({
      open_report_count: 3,
      pending_check_count: 2,
      drop_id: 'post',
      drop_deleted: true
    });
    const reportsDb = new ContentModerationDb(dbSupplier);
    expect(
      await reportsDb.getModerationQueue({ limit: 50, case_id: post.id })
    ).toHaveLength(3);

    expect(
      (
        await db.list({
          case_id: post.id,
          review_status: 'NEEDS_REVIEW',
          limit: 10
        })
      ).items
    ).toHaveLength(2);
    const category = page.items.find((c) => c.subject_type === 'REP_CATEGORY')!;
    expect(category.id).toMatch(/^[a-f0-9]{64}$/);
    expect(category.id).not.toContain('Private');
    expect(category.drop_id).toBeNull();
  });
  it('keeps different rejected new-post submissions separate before they have a post ID', async () => {
    await flag(
      {
        ...input('author:wave', 'CREATE'),
        evidence: { text: 'First submission' }
      },
      'PUBLIC_FIELD'
    );
    await flag(
      {
        ...input('author:wave', 'CREATE'),
        evidence: { text: 'Different submission' }
      },
      'PUBLIC_FIELD'
    );
    expect(await db.countReviewCases()).toBe(2);
    const page = await db.listReviewCases({ limit: 10 });
    expect(page.items).toHaveLength(2);
    for (const item of page.items) {
      expect(item).toMatchObject({ drop_id: null, drop_deleted: false });
    }
  });
  it('keeps a case until both its report and check requirements are closed', async () => {
    const first = await flag(input('post'), 'PUBLIC_FIELD');
    const reportId = await report('post');
    await sqlExecutor.execute(
      `update ${CONTENT_MODERATION_ITEMS_TABLE} set review_status='REVIEWED' where id=:id`,
      { id: first.item.id }
    );
    expect(await db.countReviewCases()).toBe(1);
    await sqlExecutor.execute(
      `update ${CONTENT_MODERATION_REPORTS_TABLE} set status='WITHDRAWN' where id=:id`,
      { id: reportId }
    );
    expect(await db.countReviewCases()).toBe(0);
    expect((await db.listReviewCases({ limit: 10 })).items).toEqual([]);
  });
  it('groups before paging, excludes reviewed/admin checks, and retains report-only legacy cases', async () => {
    await report('post');
    await report('post');
    const { item } = await flag(input('reviewed'), 'PUBLIC_FIELD');
    await sqlExecutor.execute(
      `update ${CONTENT_MODERATION_ITEMS_TABLE} set review_status='REVIEWED' where id=:id`,
      { id: item.id }
    );
    await flag(
      { ...input('admin'), scope: { administrative: true } },
      'PUBLIC_FIELD'
    );
    const other = await flag(input('other'), 'PUBLIC_FIELD');
    expect(await db.countReviewCases()).toBe(2);
    expect(
      (await db.list({ review_status: 'NEEDS_REVIEW', limit: 10 })).items.map(
        (item) => item.id
      )
    ).toEqual([other.item.id]);
    const first = await db.listReviewCases({ limit: 1 });
    expect(first.next_cursor).not.toBeNull();
    expect(first.items[0]).toMatchObject({
      check_id: other.item.id,
      pending_check_count: 1,
      open_report_count: 0
    });
    const second = await db.listReviewCases({
      limit: 1,
      before: first.next_cursor!
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      check_id: null,
      open_report_count: 2,
      pending_check_count: 0
    });
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(second.next_cursor).toBeNull();
    expect(await db.countReviewCases()).toBe(2);
  });
});
