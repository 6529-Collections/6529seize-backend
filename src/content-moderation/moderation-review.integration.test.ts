import { randomUUID } from 'node:crypto';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import { ModerationReviewDb } from './moderation-review.db';
import {
  ModerationInput,
  moderationFingerprint
} from './moderation-review.types';
import { aUserGroup } from '@/tests/fixtures/user-group.fixture';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import {
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_EVALUATIONS_TABLE,
  PROFILE_GROUPS_TABLE
} from '@/constants';

function input(): ModerationInput {
  return {
    subject_type: 'PROFILE_BIO',
    subject_id: 'author',
    author_profile_id: 'author',
    actor_profile_id: 'author',
    operation: 'UPDATE',
    policy_family: 'PUBLIC_FIELDS',
    policy_version: 'test-policy',
    scope: { current_revision: null },
    evidence: { text: 'exact submitted text' }
  };
}
describe('Moderation review durable integration', () => {
  let db: ModerationReviewDb;
  beforeEach(async () => {
    await resetTestDatabase();
    db = new ModerationReviewDb(dbSupplier);
  });
  it('retains every evaluation including cache hits while grouping identical scope', async () => {
    const first = await db.start(input(), 'PUBLIC_FIELD');
    await db.finish(first.evaluationId, {
      outcome: 'REJECT',
      result: { status: 'DISALLOWED' },
      model: 'model-one'
    });
    const second = await db.start(
      { ...input(), policy_version: 'new-policy' },
      'PUBLIC_FIELD'
    );
    await db.finish(second.evaluationId, {
      outcome: 'ALLOW',
      result: { status: 'ALLOWED' },
      cacheHit: true,
      model: 'model-two'
    });
    expect(second.item.id).toBe(first.item.id);
    const history = await db.history(first.item.id);
    expect(history.evaluations).toHaveLength(2);
    expect(history.evaluations.map((row) => row.policy_version)).toEqual(
      expect.arrayContaining(['test-policy', 'new-policy'])
    );
    expect((await db.list({ limit: 10 })).items).toHaveLength(1);
  });
  it('rolls a consumed permit back with failed content save, then permits only the same request replay', async () => {
    const check = await db.start(input(), 'PUBLIC_FIELD');
    await db.finish(check.evaluationId, { outcome: 'REJECT', result: {} });
    await db.executeNativeQueriesInTransaction(async (connection) => {
      const item = await db.get(check.item.id, { connection }, true);
      await db.decide(item, 'ALLOW', { connection });
      await db.audit(
        item,
        {
          actor: 'dev',
          action: 'ALLOW',
          reason: 'Reviewed exact text',
          actionId: randomUUID()
        },
        { connection }
      );
    });
    const key = randomUUID();
    await expect(
      db.executeNativeQueriesInTransaction(async (connection) => {
        await db.consume(check.item.id, 'new-bio', {
          connection,
          moderationRequestId: key
        });
        throw new Error('content insert failed');
      })
    ).rejects.toThrow('content insert failed');
    expect((await db.get(check.item.id)).permit_consumed_at).toBeNull();
    await db.executeNativeQueriesInTransaction(async (connection) => {
      await db.consume(check.item.id, 'new-bio', {
        connection,
        moderationRequestId: key
      });
    });
    await expect(
      db.executeNativeQueriesInTransaction((connection) =>
        db.consume(check.item.id, 'duplicate', {
          connection,
          moderationRequestId: key
        })
      )
    ).resolves.toBe('new-bio');
    await expect(
      db.executeNativeQueriesInTransaction((connection) =>
        db.consume(check.item.id, 'duplicate', {
          connection,
          moderationRequestId: randomUUID()
        })
      )
    ).rejects.toMatchObject({
      status: 409,
      code: 'MODERATION_PERMIT_CONSUMED'
    });
    expect(
      (await db.history(check.item.id)).audit.filter(
        (row) => row.action === 'CONTENT_SAVED'
      )
    ).toHaveLength(1);
  });
  it('preserves human override when a late evaluator finishes', async () => {
    const started = await db.start(input(), 'PUBLIC_FIELD');
    await db.executeNativeQueriesInTransaction(async (connection) => {
      const item = await db.get(started.item.id, { connection }, true);
      await db.decide(item, 'BLOCK', { connection });
      await db.audit(
        item,
        { actor: 'dev', action: 'BLOCK', reason: 'Human review' },
        { connection }
      );
    });
    await db.finish(started.evaluationId, { outcome: 'ALLOW', result: {} });
    expect(await db.get(started.item.id)).toMatchObject({
      override: 'BLOCK',
      review_status: 'REVIEWED'
    });
  });
  it('retains unresolved report evidence and active rule provenance while expiring reviewed payloads', async () => {
    const report = await db.start(
      { ...input(), operation: 'REPORT' },
      'CONTENT_REPORTED'
    );
    await db.finish(report.evaluationId, {
      outcome: 'ALLOW',
      result: { why: 'none' }
    });
    const reviewed = await db.start(input(), 'PUBLIC_FIELD');
    await db.finish(reviewed.evaluationId, {
      outcome: 'ALLOW',
      result: { why: 'none' }
    });
    await sqlExecutor.execute(
      `update ${CONTENT_MODERATION_ITEMS_TABLE} set evidence_expires_at=1 where id=:id`,
      { id: reviewed.item.id }
    );
    await db.retain();
    expect((await db.get(report.item.id)).evidence).toEqual(input().evidence);
    expect((await db.get(reviewed.item.id)).evidence).toBeNull();
    const result = await sqlExecutor.oneOrNull<{ result: unknown }>(
      `select result from ${CONTENT_MODERATION_EVALUATIONS_TABLE} where id=:id`,
      { id: reviewed.evaluationId }
    );
    expect(result?.result).toBeNull();
  });
  it('matches group resubmission after regenerated draft and membership-container IDs', async () => {
    const groups = new UserGroupsDb(dbSupplier);
    await groups.executeNativeQueriesInTransaction(async (connection) => {
      await groups.save(
        aUserGroup(
          {
            created_by: 'author',
            visible: false,
            profile_group_id: 'members-one',
            created_at: new Date(1)
          },
          { id: 'draft-one', name: 'Reviewed name' }
        ),
        connection
      );
      await groups.save(
        aUserGroup(
          {
            created_by: 'author',
            visible: false,
            profile_group_id: 'members-two',
            created_at: new Date(2)
          },
          { id: 'draft-two', name: 'Reviewed name' }
        ),
        connection
      );
      await sqlExecutor.execute(
        `insert into ${PROFILE_GROUPS_TABLE} (profile_group_id,profile_id) values ('members-one','alice'),('members-one','bob'),('members-two','bob'),('members-two','alice')`,
        {},
        { wrappedConnection: connection }
      );
    });
    const first = await db.groupDefinition('draft-one');
    const second = await db.groupDefinition('draft-two');
    expect(first).toEqual(second);
    const groupInput = (
      definition: Record<string, unknown> | null
    ): ModerationInput => ({
      ...input(),
      subject_type: 'GROUP_NAME',
      subject_id: 'author:new',
      operation: 'SAVE',
      scope: {
        group_review: true,
        current_revision: null,
        old_version_id: null,
        context_fingerprint: moderationFingerprint({
          definition,
          visible: true
        })
      },
      evidence: { text: 'Reviewed name' }
    });
    const attempt = await db.start(groupInput(first), 'PUBLIC_FIELD');
    expect((await db.start(groupInput(second), 'PUBLIC_FIELD')).item.id).toBe(
      attempt.item.id
    );
    expect(
      (await db.start(groupInput({ ...second, level_min: 5 }), 'PUBLIC_FIELD'))
        .item.id
    ).not.toBe(attempt.item.id);
  });
  it('purges wholly routine success history after thirty days without deleting rejected work', async () => {
    const routine = await db.start(input(), 'PUBLIC_FIELD');
    await db.finish(routine.evaluationId, { outcome: 'ALLOW', result: {} });
    const rejected = await db.start(
      { ...input(), evidence: { text: 'rejected' } },
      'PUBLIC_FIELD'
    );
    await db.finish(rejected.evaluationId, { outcome: 'REJECT', result: {} });
    await sqlExecutor.execute(
      `update ${CONTENT_MODERATION_ITEMS_TABLE} set updated_at=1`
    );
    await db.retain();
    await expect(db.get(routine.item.id)).rejects.toThrow('not found');
    expect((await db.get(rejected.item.id)).evidence).toEqual({
      text: 'rejected'
    });
  });
});
