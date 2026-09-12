import { randomUUID } from 'node:crypto';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import { ModerationReviewDb } from './moderation-review.db';
import { ModerationReviewService } from './moderation-review.service';
import { AuthenticationContext } from '@/auth-context';
import { env } from '@/env';
import { contentModerationDb } from './content-moderation.db';
import { PrePublicationCheckOutcome } from '@/entities/IContentModeration';
import {
  ModerationInput,
  moderationFingerprint
} from './moderation-review.types';
import { aUserGroup } from '@/tests/fixtures/user-group.fixture';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import {
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_EVALUATIONS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
  CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE,
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
  it('filters REP categories by opaque ID rather than their private category text', async () => {
    const category = 'Exact category text?';
    const { item } = await db.start(
      {
        ...input(),
        subject_type: 'REP_CATEGORY',
        subject_id: category,
        evidence: { text: category }
      },
      'PUBLIC_FIELD'
    );
    expect((await db.list({ subject_id: item.id, limit: 10 })).items).toEqual([
      expect.objectContaining({ id: item.id })
    ]);
    expect((await db.list({ subject_id: category, limit: 10 })).items).toEqual(
      []
    );
    const bio = await db.start(input(), 'PUBLIC_FIELD');
    expect((await db.list({ subject_id: 'author', limit: 10 })).items).toEqual([
      expect.objectContaining({ id: bio.item.id })
    ]);
  });
  describe('legacy report materialization', () => {
    const ctx = () => ({
      authenticationContext: AuthenticationContext.fromProfileId('dev')
    });
    beforeEach(() => {
      jest.spyOn(env, 'getStringArray').mockReturnValue(['dev']);
    });
    afterEach(() => jest.restoreAllMocks());
    async function legacyReport(id: string, resolvedAt: number | null = null) {
      await sqlExecutor.execute(
        `insert into ${CONTENT_MODERATION_REPORTS_TABLE}
          (id,drop_id,reporter_profile_id,author_profile_id,reason,notes,content_snapshot,status,ai_recommendation,ai_category,ai_confidence,ai_rationale,ai_evidence,ai_policy_version,ai_assessed_at,created_at,resolved_at)
          values (:id,'reported-drop','reporter','author','OTHER',:notes,cast(:snapshot as json),:status,'NO_VIOLATION_DETECTED','NONE',0.8,:rationale,cast(:evidence as json),'historical-policy',:assessedAt,:createdAt,:resolvedAt)`,
        {
          id,
          notes: `Original notes ${id}`,
          snapshot: JSON.stringify({
            title: 'Original title',
            parts: [{ content: 'Original content' }]
          }),
          status: resolvedAt === null ? 'OPEN' : 'RESOLVED_ALLOWED',
          rationale: `Original rationale ${id}`,
          evidence: JSON.stringify(['Original evaluator evidence']),
          assessedAt: 100,
          createdAt: 99,
          resolvedAt
        }
      );
    }
    it('rolls back an interrupted import and fully links the retry', async () => {
      const service = new ModerationReviewService(db);
      await legacyReport('legacy-retry');
      const bind = jest
        .spyOn(db, 'bindReport')
        .mockRejectedValueOnce(new Error('Simulated interrupted import'));
      await expect(service.reportCheck('legacy-retry', ctx())).rejects.toThrow(
        'Simulated interrupted import'
      );
      bind.mockRestore();
      expect((await db.reportForReview('legacy-retry')).item_id).toBeNull();
      expect((await db.list({ limit: 10 })).items).toHaveLength(0);
      const evaluationCount = await sqlExecutor.oneOrNull<{ count: number }>(
        `select count(*) count from ${CONTENT_MODERATION_EVALUATIONS_TABLE}`,
        {}
      );
      expect(Number(evaluationCount?.count)).toBe(0);
      const result = await service.reportCheck('legacy-retry', ctx());
      expect(result.action_effect).toBe('PUBLISHED_DROP');
      expect(result.check.published_subject_id).toBe('reported-drop');
      expect((await db.reportForReview('legacy-retry')).item_id).toBe(
        result.check.id
      );
      expect(result.evaluations).toHaveLength(1);
      expect(result.evaluations[0]).toMatchObject({
        policy_version: 'historical-policy',
        result: {
          assessed_at: 100,
          rationale: 'Original rationale legacy-retry',
          report: { notes: 'Original notes legacy-retry' }
        }
      });
    });
    it('serializes concurrent opens of one report without duplicate evaluations', async () => {
      const service = new ModerationReviewService(db);
      await legacyReport('legacy-concurrent');
      const results = await Promise.all([
        service.reportCheck('legacy-concurrent', ctx()),
        service.reportCheck('legacy-concurrent', ctx())
      ]);
      expect(results[0].check.id).toBe(results[1].check.id);
      expect((await db.history(results[0].check.id)).evaluations).toHaveLength(
        1
      );
    });
    it('links each identical report while preserving original assessments and human override', async () => {
      const service = new ModerationReviewService(db);
      await legacyReport('legacy-first');
      await legacyReport('legacy-second');
      const first = await service.reportCheck('legacy-first', ctx());
      await db.executeNativeQueriesInTransaction(async (connection) => {
        const tx = { ...ctx(), connection };
        const current = await db.get(first.check.id, tx, true);
        await db.decide(current, 'BLOCK', tx);
        await db.audit(
          current,
          { actor: 'dev', action: 'BLOCK', reason: 'Preserved human decision' },
          tx
        );
      });
      const second = await service.reportCheck('legacy-second', ctx());
      expect(second.check.id).toBe(first.check.id);
      expect(second.check.override).toBe('BLOCK');
      expect(second.evaluations).toHaveLength(2);
      expect(
        second.evaluations.map((evaluation) => evaluation.result?.rationale)
      ).toEqual(
        expect.arrayContaining([
          'Original rationale legacy-first',
          'Original rationale legacy-second'
        ])
      );
      expect((await db.reportForReview('legacy-second')).item_id).toBe(
        first.check.id
      );
      expect(second.audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actor_profile_id: 'dev',
            reason: 'Preserved human decision'
          })
        ])
      );
    });
    it('expires closed-report evidence from its actual resolution and preserves an open report sharing it', async () => {
      const service = new ModerationReviewService(db);
      const resolvedAt = Date.now() - 100 * 86400000;
      await legacyReport('legacy-closed', resolvedAt);
      const closed = await service.reportCheck('legacy-closed', ctx());
      expect(closed.check.evidence_expires_at).toBe(resolvedAt + 90 * 86400000);
      expect(closed.evidence_expired).toBe(true);
      expect(closed.evaluations[0].result).toBeNull();
      expect(closed.allowed_actions).not.toContain('REEVALUATE');
      await legacyReport('legacy-open');
      const open = await service.reportCheck('legacy-open', ctx());
      expect(open.check.id).toBe(closed.check.id);
      expect(open.check.evidence_expires_at).toBeNull();
      await db.retain();
      expect((await db.get(open.check.id)).evidence).not.toBeNull();
    });
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
  it('paginates mixed detailed and routine checks without gaps at shared timestamps', async () => {
    for (let index = 0; index < 6; index++) {
      const check = await db.start(
        { ...input(), subject_id: `profile-${index}` },
        'PUBLIC_FIELD'
      );
      await db.finish(check.evaluationId, { outcome: 'ALLOW', result: {} });
      await contentModerationDb.recordPrePublicationCheck({
        dropId: `drop-${index}`,
        authorProfileId: 'author',
        operation: 'CREATE',
        deterministicGateVersion: 'test',
        contentFingerprint: moderationFingerprint(index),
        deterministicSignal: null,
        outcome: PrePublicationCheckOutcome.ALLOW,
        evaluatorVersion: null,
        evaluatorResult: null
      });
    }
    await sqlExecutor.execute(
      `update ${CONTENT_MODERATION_ITEMS_TABLE} set created_at=100`,
      {}
    );
    await sqlExecutor.execute(
      `update ${CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE} set created_at=100`,
      {}
    );
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await db.list({ limit: 3, before: cursor ?? undefined });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(ids.filter((id) => id.startsWith('routine:'))).toHaveLength(6);
    const publicFields = await db.list({
      limit: 20,
      subject_type: 'PROFILE_BIO',
      profile_id: 'author'
    });
    expect(publicFields.items).toHaveLength(6);
    expect(publicFields.next_cursor).toBeNull();
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
