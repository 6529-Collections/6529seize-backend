import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import {
  CONTENT_MODERATION_AUDIT_LOG_TABLE,
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { ContentReportReason } from '@/entities/IContentModeration';
import { ContentModerationDb } from './content-moderation.db';
import { ModerationReviewDb } from './moderation-review.db';
import { ModerationReviewService } from './moderation-review.service';
import { moderationFingerprint } from './moderation-review.types';
import { MODERATION_DEVELOPER_GROUP_ID } from './moderation-developer-access';

describe('Deleted-post report resolution', () => {
  let reviews: ModerationReviewDb;
  let content: ContentModerationDb;
  let service: ModerationReviewService;
  const ctx = () => ({
    authenticationContext: AuthenticationContext.fromProfileId('developer')
  });
  beforeEach(async () => {
    await resetTestDatabase();
    reviews = new ModerationReviewDb(dbSupplier);
    content = new ContentModerationDb(dbSupplier);
    service = new ModerationReviewService(reviews);
    jest
      .spyOn(userGroupsService, 'getGroupsUserIsEligibleForByIds')
      .mockImplementation(async (profileId) =>
        profileId === 'developer' ? [MODERATION_DEVELOPER_GROUP_ID] : []
      );
  });
  afterEach(() => jest.restoreAllMocks());

  async function report(text = 'Reported post', pending = false) {
    const evidence = {
      drop_id: 'deleted-post',
      wave_id: 'wave',
      title: null,
      parts: [{ content: text }]
    };
    const revision = moderationFingerprint({
      title: null,
      parts: evidence.parts
    });
    const started = await reviews.start(
      {
        subject_type: 'DROP',
        subject_id: 'deleted-post',
        author_profile_id: 'author',
        actor_profile_id: 'reporter',
        operation: 'REPORT',
        policy_family: 'WAVE_CONTENT',
        policy_version: 'test-policy',
        scope: { current_revision: revision },
        evidence
      },
      'CONTENT_REPORTED'
    );
    if (!pending)
      await reviews.finish(started.evaluationId, {
        outcome: 'ALLOW',
        result: { recommendation: 'NO_VIOLATION_DETECTED' }
      });
    await reviews.attachPublication(started.item.id, 'deleted-post', revision);
    const reportId = randomUUID();
    await sqlExecutor.execute(
      `insert into ${CONTENT_MODERATION_REPORTS_TABLE}
        (id,item_id,drop_id,reporter_profile_id,author_profile_id,reason,content_snapshot,status,created_at)
        values (:id,:itemId,'deleted-post','reporter','author','SPAM',cast(:snapshot as json),'OPEN',:createdAt)`,
      {
        id: reportId,
        itemId: started.item.id,
        snapshot: JSON.stringify(evidence),
        createdAt: Date.now()
      }
    );
    return {
      reportId,
      itemId: started.item.id,
      evaluationId: started.evaluationId,
      evidence
    };
  }
  async function livePost() {
    await sqlExecutor.execute(
      `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count) values ('deleted-post','wave','author',1,0)`
    );
  }
  async function resolve(itemId: string, idempotencyKey = randomUUID()) {
    const detail = await service.detail(itemId, ctx());
    const action = {
      action: 'RESOLVE_DELETED_REPORT' as const,
      reason: 'Original post has been deleted',
      expected_version: detail.check.version,
      idempotency_key: idempotencyKey
    };
    return { action, result: await service.action(itemId, action, ctx()) };
  }

  it('closes open reports across revisions, clears the badge and preserves evidence and audited resolution', async () => {
    const first = await report();
    const second = await report('An earlier saved revision');
    expect(await content.hasOpenReports()).toBe(true);
    const before = await content.getModerationQueue({ limit: 10 });
    expect(before).toHaveLength(2);
    expect(before.every((row) => row.drop_deleted)).toBe(true);
    const { action, result } = await resolve(first.itemId);
    expect(result.current_state).toMatchObject({
      deleted: true,
      published: false,
      drop_status: null,
      open_report_count: 0
    });
    expect(result.allowed_actions).not.toContain('RESOLVE_DELETED_REPORT');
    expect(await content.hasOpenReports()).toBe(false);
    expect(await content.getModerationCounts()).toMatchObject({
      open_report_count: 0,
      resolved_report_count: 2
    });
    expect(await content.getModerationQueue({ limit: 10 })).toEqual([]);
    const resolved = await content.getModerationQueue({
      limit: 10,
      view: 'RESOLVED'
    });
    expect(resolved).toHaveLength(2);
    expect(resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.reportId,
          status: 'RESOLVED_DELETED',
          resolved_by_profile_id: 'developer',
          resolution_reason: action.reason,
          content_snapshot: first.evidence
        }),
        expect.objectContaining({
          id: second.reportId,
          status: 'RESOLVED_DELETED'
        })
      ])
    );
    expect(result.evidence).toEqual(first.evidence);
    const other = await reviews.get(second.itemId);
    expect(other.review_status).toBe('REVIEWED');
    expect(other.evidence_expires_at).toBeGreaterThan(Date.now());
    expect(result.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'RESOLVE_DELETED_REPORT',
          actor_profile_id: 'developer',
          reason: action.reason
        })
      ])
    );
    await service.action(first.itemId, action, ctx());
    const audits = await sqlExecutor.execute<{ count: number }>(
      `select count(*) as count from ${CONTENT_MODERATION_AUDIT_LOG_TABLE} where action='RESOLVE_DELETED_REPORT'`
    );
    expect(audits[0]?.count).toBe(1);
  });

  it('does not mistake live or edited posts for deleted posts and guards the repository write too', async () => {
    const saved = await report();
    await livePost();
    const detail = await service.detail(saved.itemId, ctx());
    expect(detail.current_state.deleted).toBe(false);
    expect(detail.allowed_actions).not.toContain('RESOLVE_DELETED_REPORT');
    await expect(resolve(saved.itemId)).rejects.toThrow('unavailable');
    await expect(
      reviews.executeNativeQueriesInTransaction((connection) =>
        reviews.resolveDeletedReports(
          'deleted-post',
          'developer',
          'Must not resolve a live post',
          { connection }
        )
      )
    ).rejects.toThrow('Refresh');
    expect(await content.hasOpenReports()).toBe(true);
  });

  it('rolls back report closure if its audit cannot be saved', async () => {
    const saved = await report();
    jest
      .spyOn(reviews, 'audit')
      .mockRejectedValueOnce(new Error('Audit unavailable'));
    await expect(resolve(saved.itemId)).rejects.toThrow('Audit unavailable');
    expect(await content.hasOpenReports()).toBe(true);
    expect((await reviews.get(saved.itemId)).review_status).toBe(
      'NEEDS_REVIEW'
    );
    expect((await content.getModerationCounts()).resolved_report_count).toBe(0);
  });

  it('does not reopen resolved work through a report request holding a pre-deletion snapshot', async () => {
    const saved = await report();
    await resolve(saved.itemId);
    // Eligibility is independent of the live-post guard exercised here.
    jest
      .spyOn(content as any, 'assertReportAllowed')
      .mockResolvedValue(undefined);
    await expect(
      content.createReportWithViewerActions(
        {
          dropId: 'deleted-post',
          reporterProfileId: 'late-reporter',
          authorProfileId: 'author',
          reason: ContentReportReason.SPAM,
          notes: null,
          contentSnapshot: saved.evidence,
          hideDrop: false,
          blockAuthor: false
        },
        {}
      )
    ).rejects.toThrow('Drop deleted-post not found');
    expect(await content.hasOpenReports()).toBe(false);
    expect((await reviews.get(saved.itemId)).review_status).toBe('REVIEWED');
    expect((await content.getModerationCounts()).resolved_report_count).toBe(1);
  });

  it('does not revive expired retained evidence on the selected or an older resolved revision', async () => {
    const old = await report('Older resolved revision');
    const selected = await report('Selected expired revision');
    await report('Fresh open revision');
    const expiredAt = Date.now() - 86400000;
    await sqlExecutor.execute(
      `update ${CONTENT_MODERATION_REPORTS_TABLE} set status='RESOLVED_ALLOWED',resolved_at=:expiredAt where id=:id`,
      { expiredAt: Date.now() - 91 * 86400000, id: old.reportId }
    );
    await sqlExecutor.execute(
      `update ${CONTENT_MODERATION_ITEMS_TABLE} set evidence_expires_at=:expiredAt where id in (:ids)`,
      { expiredAt, ids: [old.itemId, selected.itemId] }
    );
    await resolve(selected.itemId);
    await reviews.retain();
    for (const id of [old.itemId, selected.itemId]) {
      const detail = await service.detail(id, ctx());
      expect(detail.check.evidence_expires_at).toBe(expiredAt);
      expect(detail.evidence_expired).toBe(true);
      expect(detail.evidence).toBeNull();
      expect(detail.evaluations.every((e) => e.result === null)).toBe(true);
    }
    expect(await content.hasOpenReports()).toBe(false);
  });
  it('keeps sibling reports reviewed when their pending classifier finishes after resolution', async () => {
    const selected = await report();
    const sibling = await report('A pending earlier revision', true);
    await resolve(selected.itemId);
    const resolved = await reviews.get(sibling.itemId);
    await reviews.finish(sibling.evaluationId, {
      outcome: 'REJECT',
      result: { recommendation: 'NEEDS_HUMAN_REVIEW' }
    });
    const finished = await reviews.get(sibling.itemId);
    expect(finished.review_status).toBe('REVIEWED');
    expect(finished.evidence_expires_at).toBe(resolved.evidence_expires_at);
    expect(await content.hasOpenReports()).toBe(false);
  });
});
