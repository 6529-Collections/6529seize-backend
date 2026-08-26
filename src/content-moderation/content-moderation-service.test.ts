import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus,
  DropModerationStatus
} from '@/entities/IContentModeration';
import { ForbiddenException } from '@/exceptions';
import { env } from '@/env';
import { ContentModerationAiService } from './content-moderation-ai.service';
import { ContentModerationDb } from './content-moderation.db';
import { ContentModerationService } from './content-moderation.service';

type ContentModerationDbMock = jest.Mocked<
  Pick<
    ContentModerationDb,
    | 'applyModeratorDropDecision'
    | 'createReportWithViewerActions'
    | 'getAuditHistoryForDrops'
    | 'getDropSnapshot'
    | 'getModerationCounts'
    | 'getModerationQueue'
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
    service: new ContentModerationService(db, aiService),
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

  it('combines developer and additional moderator profile IDs', async () => {
    const { service, db } = createService();
    jest.spyOn(env, 'getStringArray').mockImplementation((name) => {
      if (name === 'DEVS_6529_MENTION_PROFILE_IDS') {
        return [' dev-1 ', 'shared'];
      }
      if (name === 'CONTENT_MODERATOR_PROFILE_IDS') {
        return ['shared', ' moderator-1 '];
      }
      return [];
    });
    db.isModerator.mockResolvedValue(true);
    db.getModerationCounts.mockResolvedValue({
      open_report_count: 3,
      resolved_report_count: 8,
      suspended_profile_count: 2
    });

    await expect(
      service.getModeratorAccess('moderator-1', {})
    ).resolves.toEqual({
      moderator: true,
      has_open_reports: true,
      open_report_count: 3,
      resolved_report_count: 8,
      suspended_profile_count: 2
    });
    expect(db.isModerator).toHaveBeenCalledWith(
      'moderator-1',
      ['dev-1', 'shared', 'moderator-1'],
      undefined
    );
    expect(db.getModerationCounts).toHaveBeenCalledWith(undefined);
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

  it('supports a moderation decision without an optional note', async () => {
    const { service, db } = createService();
    db.isModerator.mockResolvedValue(true);

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
