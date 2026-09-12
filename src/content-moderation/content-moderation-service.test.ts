import { ApiContentModerationBlockActivityItemActionEnum } from '@/api/generated/models/ApiContentModerationBlockActivityItem';
import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus,
  DropModerationStatus,
  ModeratedProfileStatus
} from '@/entities/IContentModeration';
import { ForbiddenException } from '@/exceptions';
import { env } from '@/env';
import { ContentModerationAiService } from './content-moderation-ai.service';
import { ContentModerationDb } from './content-moderation.db';
import { ContentModerationService } from './content-moderation.service';
import { ModerationReviewDb } from './moderation-review.db';
import { moderationFingerprint } from './moderation-review.types';

type ContentModerationDbMock = jest.Mocked<
  Pick<
    ContentModerationDb,
    | 'applyModeratorDropDecision'
    | 'createReportWithViewerActions'
    | 'getAuditHistoryForDrops'
    | 'getBlockActivity'
    | 'getDropSnapshot'
    | 'getExistingProfileStatus'
    | 'getModerationCounts'
    | 'getModerationQueue'
    | 'getReportsForProfile'
    | 'getPresentations'
    | 'getSuspendedProfiles'
    | 'isModerator'
    | 'saveReportAssessment'
    | 'setProfileStatus'
    | 'tryAiQuarantineForOpenReport'
    | 'withdrawOpenReport'
  >
>;

type ContentModerationAiServiceMock = jest.Mocked<
  Pick<ContentModerationAiService, 'assessReportedContent'>
>;

function reportRow() {
  return {
    id: 'report-1',
    drop_id: 'drop-1',
    reporter_profile_id: 'reporter-1',
    author_profile_id: 'author-1',
    reason: ContentReportReason.SCAM_OR_PHISHING,
    notes: null,
    content_snapshot: {},
    status: ContentReportStatus.OPEN,
    ai_recommendation: null,
    ai_category: null,
    ai_confidence: null,
    ai_rationale: null,
    ai_evidence: null,
    ai_policy_version: null,
    ai_assessed_at: null,
    created_at: 1,
    resolved_by_profile_id: null,
    resolution_reason: null,
    resolved_at: null
  };
}

function createService() {
  const snapshot = {
    drop_id: 'drop-1',
    author_profile_id: 'author-1',
    wave_id: 'wave-1',
    title: null,
    parts: [
      {
        part_no: 1,
        content: 'reported content',
        media: [],
        attachments: []
      }
    ],
    reply_to_drop_id: null
  };
  const db: ContentModerationDbMock = {
    getDropSnapshot: jest.fn().mockResolvedValue(snapshot),
    getExistingProfileStatus: jest
      .fn()
      .mockResolvedValue(ModeratedProfileStatus.ACTIVE),
    createReportWithViewerActions: jest.fn().mockResolvedValue(reportRow()),
    saveReportAssessment: jest.fn().mockResolvedValue(undefined),
    tryAiQuarantineForOpenReport: jest.fn().mockResolvedValue(true),
    applyModeratorDropDecision: jest.fn().mockResolvedValue(undefined),
    isModerator: jest.fn().mockResolvedValue(false),
    getModerationCounts: jest.fn().mockResolvedValue({
      open_report_count: 0,
      resolved_report_count: 0,
      suspended_profile_count: 0
    }),
    getModerationQueue: jest.fn().mockResolvedValue([]),
    getBlockActivity: jest.fn().mockResolvedValue([]),
    getReportsForProfile: jest.fn().mockResolvedValue([]),
    getSuspendedProfiles: jest.fn().mockResolvedValue([]),
    getPresentations: jest.fn().mockResolvedValue({
      'drop-1': {
        viewer: { author_blocked: false, drop_hidden: false },
        moderation: {
          status: DropModerationStatus.VISIBLE,
          can_view: true
        }
      }
    }),
    getAuditHistoryForDrops: jest.fn().mockResolvedValue({}),
    setProfileStatus: jest.fn().mockResolvedValue(undefined),
    withdrawOpenReport: jest
      .fn()
      .mockResolvedValue(DropModerationStatus.VISIBLE)
  };
  const aiService: ContentModerationAiServiceMock = {
    assessReportedContent: jest.fn().mockResolvedValue({
      recommendation: ContentModerationRecommendation.NO_VIOLATION_DETECTED,
      category: 'NONE',
      confidence: 0.9,
      rationale: 'No violation',
      evidence: []
    })
  };
  return {
    service: new ContentModerationService(db, aiService, {
      start: jest.fn().mockResolvedValue({
        item: { id: 'review-item', version: 1 },
        evaluationId: 'evaluation'
      }),
      attachPublication: jest.fn(),
      bindReport: jest.fn(),
      finish: jest.fn(),
      lockSubject: jest.fn(),
      audit: jest.fn(),
      bumpVersion: jest.fn(),
      invalidateRelatedVersions: jest.fn(),
      get: jest
        .fn()
        .mockResolvedValue({ id: 'review-item', version: 2, override: null }),
      currentRevision: jest.fn().mockResolvedValue(
        moderationFingerprint({
          title: snapshot.title,
          parts: snapshot.parts.map((part) => ({ content: part.content }))
        })
      ),
      executeNativeQueriesInTransaction: jest.fn(async (run) => run({}))
    } as unknown as ModerationReviewDb),
    db,
    aiService,
    snapshot
  };
}

describe('ContentModerationService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns only reports scoped to the authenticated profile', async () => {
    const { service, db } = createService();

    await service.getReportsForProfile(
      'reporter-1',
      { limit: 25, before: 'cursor' },
      { connection: {} as any }
    );

    expect(db.getReportsForProfile).toHaveBeenCalledWith(
      'reporter-1',
      { limit: 25, before: 'cursor' },
      expect.any(Object)
    );
    expect(db.isModerator).not.toHaveBeenCalled();
  });

  it('returns block activity only to an authorized moderator', async () => {
    const { service, db } = createService();

    await expect(
      service.getBlockActivity(
        'profile-1',
        { limit: 25, before: '500.42', include_unblocks: true },
        {}
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.getBlockActivity).not.toHaveBeenCalled();

    jest
      .spyOn(env, 'getStringArray')
      .mockImplementation((name) =>
        name === 'DEVS_6529_MENTION_PROFILE_IDS'
          ? ['profile-1', 'moderator-1']
          : []
      );
    db.getBlockActivity.mockResolvedValue([
      {
        id: '42',
        action: ApiContentModerationBlockActivityItemActionEnum.Unblocked,
        blocker_profile_id: 'blocker-1',
        blocker_handle: 'blocker',
        blocker_pfp: null,
        blocked_profile_id: 'blocked-1',
        blocked_handle: 'blocked',
        blocked_pfp: null,
        created_at: 500,
        cursor: '500.42'
      }
    ]);

    await expect(
      service.getBlockActivity(
        'moderator-1',
        { limit: 25, before: '500.42', include_unblocks: true },
        {}
      )
    ).resolves.toEqual([
      expect.objectContaining({ id: '42', action: 'PROFILE_UNBLOCKED' })
    ]);
    expect(db.getBlockActivity).toHaveBeenCalledWith(
      { limit: 25, before: '500.42', include_unblocks: true },
      undefined
    );
  });

  it('persists the report and personal actions atomically before AI assessment', async () => {
    const { service, db, aiService } = createService();

    await service.submitReport(
      {
        dropId: 'drop-1',
        reporterProfileId: 'reporter-1',
        reason: ContentReportReason.SCAM_OR_PHISHING,
        notes: null,
        hideDrop: true,
        blockAuthor: true
      },
      {}
    );

    const reportOrder =
      db.createReportWithViewerActions.mock.invocationCallOrder[0]!;
    expect(reportOrder).toBeLessThan(
      aiService.assessReportedContent.mock.invocationCallOrder[0]!
    );
    expect(db.createReportWithViewerActions).toHaveBeenCalledWith(
      expect.objectContaining({
        reporterProfileId: 'reporter-1',
        authorProfileId: 'author-1',
        hideDrop: true,
        blockAuthor: true
      }),
      {}
    );
  });

  it('persists reply context with the private report evidence', async () => {
    const { service, db, aiService, snapshot } = createService();
    db.createReportWithViewerActions.mockResolvedValue({
      ...reportRow(),
      reason: ContentReportReason.OTHER
    });
    const reportedReply = { ...snapshot, reply_to_drop_id: 'parent-drop' };
    const parentSnapshot = {
      ...snapshot,
      drop_id: 'parent-drop',
      parts: [
        {
          part_no: 1,
          content: 'parent context',
          media: [],
          attachments: []
        }
      ]
    };
    db.getDropSnapshot
      .mockReset()
      .mockResolvedValueOnce(reportedReply)
      .mockResolvedValueOnce(parentSnapshot);

    await service.submitReport(
      {
        dropId: 'drop-1',
        reporterProfileId: 'reporter-1',
        reason: ContentReportReason.OTHER,
        notes: null,
        hideDrop: false,
        blockAuthor: false
      },
      {}
    );

    expect(db.createReportWithViewerActions).toHaveBeenCalledWith(
      expect.objectContaining({
        contentSnapshot: {
          ...reportedReply,
          parent_context: parentSnapshot
        }
      }),
      {}
    );
    expect(aiService.assessReportedContent).toHaveBeenCalledWith({
      reason: ContentReportReason.OTHER,
      content: reportedReply,
      parentContext: parentSnapshot
    });
  });

  it('quarantines only an urgent AI recommendation', async () => {
    const { service, db, aiService } = createService();
    aiService.assessReportedContent.mockResolvedValue({
      recommendation: ContentModerationRecommendation.URGENT_QUARANTINE,
      category: 'CREDIBLE_THREAT',
      confidence: 0.99,
      rationale: 'Imminent safety risk',
      evidence: ['explicit statement']
    });
    db.getPresentations.mockResolvedValue({
      'drop-1': {
        viewer: { author_blocked: false, drop_hidden: false },
        moderation: {
          status: DropModerationStatus.AI_QUARANTINED,
          can_view: false
        }
      }
    });

    await expect(
      service.submitReport(
        {
          dropId: 'drop-1',
          reporterProfileId: 'reporter-1',
          reason: ContentReportReason.THREATS_OR_TARGETED_HARASSMENT,
          notes: null,
          hideDrop: false,
          blockAuthor: false
        },
        {}
      )
    ).resolves.toEqual({
      id: 'report-1',
      status: ContentReportStatus.OPEN,
      drop_status: DropModerationStatus.AI_QUARANTINED
    });
    expect(db.tryAiQuarantineForOpenReport).toHaveBeenCalledWith(
      {
        reportId: 'report-1',
        dropId: 'drop-1',
        reason: 'Imminent safety risk'
      },
      expect.objectContaining({ connection: expect.any(Object) })
    );
  });

  it('does not quarantine a low-confidence urgent recommendation', async () => {
    const { service, db, aiService } = createService();
    aiService.assessReportedContent.mockResolvedValue({
      recommendation: ContentModerationRecommendation.URGENT_QUARANTINE,
      category: 'CREDIBLE_THREAT',
      confidence: 0.8,
      rationale: 'Insufficient confidence',
      evidence: []
    });

    await service.submitReport(
      {
        dropId: 'drop-1',
        reporterProfileId: 'reporter-1',
        reason: ContentReportReason.THREATS_OR_TARGETED_HARASSMENT,
        notes: null,
        hideDrop: false,
        blockAuthor: false
      },
      {}
    );

    expect(db.tryAiQuarantineForOpenReport).not.toHaveBeenCalled();
  });

  it('never lets an AI assessment downgrade an existing moderator removal', async () => {
    const { service, db, aiService } = createService();
    db.getPresentations.mockResolvedValue({
      'drop-1': {
        viewer: { author_blocked: false, drop_hidden: false },
        moderation: {
          status: DropModerationStatus.MODERATOR_REMOVED,
          can_view: false
        }
      }
    });
    aiService.assessReportedContent.mockResolvedValue({
      recommendation: ContentModerationRecommendation.URGENT_QUARANTINE,
      category: 'CREDIBLE_THREAT',
      confidence: 0.99,
      rationale: 'Imminent safety risk',
      evidence: ['explicit statement']
    });
    db.tryAiQuarantineForOpenReport.mockResolvedValue(false);

    await expect(
      service.submitReport(
        {
          dropId: 'drop-1',
          reporterProfileId: 'reporter-1',
          reason: ContentReportReason.THREATS_OR_TARGETED_HARASSMENT,
          notes: null,
          hideDrop: false,
          blockAuthor: false
        },
        {}
      )
    ).resolves.toEqual({
      id: 'report-1',
      status: ContentReportStatus.OPEN,
      drop_status: DropModerationStatus.MODERATOR_REMOVED
    });
    expect(db.tryAiQuarantineForOpenReport).toHaveBeenCalled();
  });

  it('keeps a persisted report for human review when AI is unavailable', async () => {
    const { service, db, aiService } = createService();
    aiService.assessReportedContent.mockRejectedValue(new Error('unavailable'));

    await service.submitReport(
      {
        dropId: 'drop-1',
        reporterProfileId: 'reporter-1',
        reason: ContentReportReason.OTHER,
        notes: null,
        hideDrop: false,
        blockAuthor: false
      },
      {}
    );

    expect(db.saveReportAssessment).toHaveBeenCalledWith(
      'report-1',
      expect.objectContaining({
        recommendation: ContentModerationRecommendation.NEEDS_HUMAN_REVIEW,
        category: 'CLASSIFIER_UNAVAILABLE'
      }),
      undefined
    );
    expect(db.tryAiQuarantineForOpenReport).not.toHaveBeenCalled();
  });

  it('enforces moderator access before reading the private queue', async () => {
    const { service, db } = createService();

    await expect(
      service.getQueue('ordinary-profile', { limit: 50 }, {})
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.getModerationQueue).not.toHaveBeenCalled();
  });

  it('uses only the exact developer set and ignores broader moderator roles', async () => {
    const { service, db } = createService();
    jest
      .spyOn(env, 'getStringArray')
      .mockImplementation((name) =>
        name === 'DEVS_6529_MENTION_PROFILE_IDS' ? [' dev-1 '] : ['moderator-1']
      );
    db.isModerator.mockResolvedValue(true);
    await expect(
      service.getModeratorAccess('moderator-1', {})
    ).resolves.toMatchObject({ moderator: false });
    await expect(
      service.getModeratorAccess('dev-1', {})
    ).resolves.toMatchObject({ moderator: true });
    expect(db.isModerator).not.toHaveBeenCalled();
  });

  it('does not query the open queue state for a non-moderator', async () => {
    const { service, db } = createService();

    await expect(
      service.getModeratorAccess('ordinary-profile', {})
    ).resolves.toEqual({
      moderator: false,
      has_open_reports: false,
      open_report_count: 0,
      resolved_report_count: 0,
      suspended_profile_count: 0
    });
    expect(db.getModerationCounts).not.toHaveBeenCalled();
  });

  it('returns a public profile moderation status without moderator access', async () => {
    const { service, db } = createService();
    db.getExistingProfileStatus.mockResolvedValue(
      ModeratedProfileStatus.SUSPENDED
    );

    await expect(
      service.getPublicProfileStatus('profile-1', {})
    ).resolves.toEqual({
      profile_id: 'profile-1',
      status: ModeratedProfileStatus.SUSPENDED
    });
    expect(db.getExistingProfileStatus).toHaveBeenCalledWith(
      'profile-1',
      undefined
    );
    expect(db.isModerator).not.toHaveBeenCalled();
  });

  it('applies moderator state and report resolution atomically', async () => {
    const { service, db } = createService();
    jest
      .spyOn(env, 'getStringArray')
      .mockImplementation((name) =>
        name === 'DEVS_6529_MENTION_PROFILE_IDS'
          ? ['profile-1', 'moderator-1']
          : []
      );

    await service.decideDrop(
      'moderator-1',
      { dropId: 'drop-1', decision: 'ALLOW', reason: 'Reviewed in context' },
      {}
    );

    expect(db.applyModeratorDropDecision).toHaveBeenCalledWith(
      {
        dropId: 'drop-1',
        status: DropModerationStatus.VISIBLE,
        actorProfileId: 'moderator-1',
        action: 'MODERATOR_ALLOWED_OR_RESTORED',
        reason: 'Reviewed in context',
        reportStatus: ContentReportStatus.RESOLVED_ALLOWED
      },
      {}
    );
  });

  it('supports a moderation decision without an optional note', async () => {
    const { service, db } = createService();
    jest
      .spyOn(env, 'getStringArray')
      .mockImplementation((name) =>
        name === 'DEVS_6529_MENTION_PROFILE_IDS'
          ? ['profile-1', 'moderator-1']
          : []
      );

    await service.decideDrop(
      'moderator-1',
      { dropId: 'drop-1', decision: 'REMOVE', reason: null },
      {}
    );

    expect(db.applyModeratorDropDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: null,
        reportStatus: ContentReportStatus.RESOLVED_REMOVED
      }),
      {}
    );
  });

  it('withdraws the reporter open report without requiring moderator access', async () => {
    const { service, db } = createService();

    await expect(
      service.withdrawReport('reporter-1', 'drop-1', {})
    ).resolves.toEqual({
      drop_id: 'drop-1',
      status: ContentReportStatus.WITHDRAWN,
      drop_status: DropModerationStatus.VISIBLE
    });
    expect(db.withdrawOpenReport).toHaveBeenCalledWith(
      'reporter-1',
      'drop-1',
      {}
    );
  });
});
