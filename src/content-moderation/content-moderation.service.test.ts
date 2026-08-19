import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus,
  DropModerationStatus
} from '@/entities/IContentModeration';
import { ForbiddenException } from '@/exceptions';
import { ContentModerationService } from './content-moderation.service';

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
    parts: [{ part_no: 1, content: 'reported content' }],
    reply_to_drop_id: null
  };
  const db = {
    getDropSnapshot: jest.fn().mockResolvedValue(snapshot),
    createReportWithViewerActions: jest.fn().mockResolvedValue(reportRow()),
    saveReportAssessment: jest.fn().mockResolvedValue(undefined),
    tryAiQuarantineForOpenReport: jest.fn().mockResolvedValue(true),
    applyModeratorDropDecision: jest.fn().mockResolvedValue(undefined),
    isModerator: jest.fn().mockResolvedValue(false),
    getModerationQueue: jest.fn().mockResolvedValue([]),
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
    resolveOpenReportsForDrop: jest.fn().mockResolvedValue(undefined),
    setProfileStatus: jest.fn().mockResolvedValue(undefined)
  };
  const aiService = {
    assessReportedContent: jest.fn().mockResolvedValue({
      recommendation: ContentModerationRecommendation.NO_VIOLATION_DETECTED,
      category: 'NONE',
      confidence: 0.9,
      rationale: 'No violation',
      evidence: []
    })
  };
  return {
    service: new ContentModerationService(db as any, aiService as any),
    db,
    aiService,
    snapshot
  };
}

describe('ContentModerationService', () => {
  afterEach(() => jest.restoreAllMocks());

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
    const reportedReply = { ...snapshot, reply_to_drop_id: 'parent-drop' };
    const parentSnapshot = {
      ...snapshot,
      drop_id: 'parent-drop',
      parts: [{ part_no: 1, content: 'parent context' }]
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
      reason: ContentReportReason.SCAM_OR_PHISHING,
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
      {}
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

  it('applies moderator state and report resolution atomically', async () => {
    const { service, db } = createService();
    db.isModerator.mockResolvedValue(true);

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
});
