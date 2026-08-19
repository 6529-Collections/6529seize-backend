import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus,
  DropModerationStatus,
  PrePublicationCheckOutcome
} from '@/entities/IContentModeration';
import { BadRequestException } from '@/exceptions';
import { ContentModerationDb } from './content-moderation.db';

const REPORT_ID = '11111111-1111-4111-8111-111111111111';

function createDb() {
  const executor = {
    execute: jest.fn().mockResolvedValue([]),
    oneOrNull: jest.fn().mockResolvedValue(null)
  };
  return {
    executor,
    db: new ContentModerationDb(() => executor as any)
  };
}

function reportRow() {
  return {
    id: REPORT_ID,
    drop_id: 'drop-1',
    reporter_profile_id: 'reporter-1',
    author_profile_id: 'author-1',
    reason: ContentReportReason.SCAM_OR_PHISHING,
    notes: null,
    content_snapshot: {},
    status: ContentReportStatus.OPEN,
    ai_recommendation: ContentModerationRecommendation.URGENT_QUARANTINE,
    ai_category: 'SCAM_OR_PHISHING',
    ai_confidence: 0.99,
    ai_rationale: 'Known phishing flow',
    ai_evidence: [],
    ai_policy_version: 'policy-1',
    ai_assessed_at: 100,
    created_at: 200,
    resolved_by_profile_id: null,
    resolution_reason: null,
    resolved_at: null,
    report_count: 2,
    recommendation_rank: 0
  };
}

describe('ContentModerationDb', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps globally moderated content visible to its author only', async () => {
    const { db, executor } = createDb();
    executor.execute.mockImplementation((sql: string) => {
      if (sql.includes('content_moderation_drop_states')) {
        return Promise.resolve([
          {
            drop_id: 'drop-1',
            status: DropModerationStatus.AI_QUARANTINED
          }
        ]);
      }
      return Promise.resolve([]);
    });

    const authorPresentation = await db.getPresentations(
      [{ id: 'drop-1', author_id: 'author-1' }],
      'author-1'
    );
    const otherPresentation = await db.getPresentations(
      [{ id: 'drop-1', author_id: 'author-1' }],
      'viewer-1'
    );

    expect(authorPresentation['drop-1']?.moderation.can_view).toBe(true);
    expect(otherPresentation['drop-1']?.moderation.can_view).toBe(false);
  });

  it('does not persist environment-seeded moderator access during a read', async () => {
    const { db, executor } = createDb();

    await expect(db.isModerator('moderator-1', ['moderator-1'])).resolves.toBe(
      true
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.oneOrNull).not.toHaveBeenCalled();
  });

  it('returns and consumes a stable queue cursor matching its priority order', async () => {
    const { db, executor } = createDb();
    executor.execute.mockResolvedValue([reportRow()]);

    const firstPage = await db.getModerationQueue({ limit: 1 });
    expect(firstPage[0]?.cursor).toBe(`0.200.${REPORT_ID}`);

    await db.getModerationQueue({
      limit: 1,
      before: firstPage[0]!.cursor
    });
    expect(executor.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('r.id < :beforeReportId'),
      expect.objectContaining({
        beforeRank: 0,
        beforeCreatedAt: 200,
        beforeReportId: REPORT_ID
      }),
      undefined
    );
  });

  it('rejects malformed moderation queue cursors', async () => {
    const { db, executor } = createDb();

    await expect(
      db.getModerationQueue({ limit: 1, before: 'not-a-cursor' })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('records pre-publication checks on the caller transaction', async () => {
    const { db, executor } = createDb();
    const connection = {} as any;

    await db.recordPrePublicationCheck(
      {
        dropId: 'drop-1',
        authorProfileId: 'author-1',
        operation: 'CREATE',
        deterministicGateVersion: 'gate-1',
        contentFingerprint: 'fingerprint',
        signal: null,
        outcome: PrePublicationCheckOutcome.ALLOW,
        evaluatorVersion: null,
        evaluatorResult: null
      },
      connection
    );

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('content_moderation_pre_publication_checks'),
      expect.any(Object),
      { wrappedConnection: connection }
    );
  });

  it('commits report and requested viewer actions in one transaction', async () => {
    const { db } = createDb();
    const connection = {} as any;
    const report = reportRow();
    const transactionSpy = jest
      .spyOn(db as any, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (...args: unknown[]) => {
        const executable = args[0] as (value: any) => Promise<unknown>;
        return executable(connection);
      });
    const createReportSpy = jest
      .spyOn(db, 'createReport')
      .mockResolvedValue(report);
    const blockProfileSpy = jest
      .spyOn(db, 'blockProfile')
      .mockResolvedValue(undefined);
    const hideDropSpy = jest.spyOn(db, 'hideDrop').mockResolvedValue(undefined);

    await expect(
      db.createReportWithViewerActions(
        {
          dropId: 'drop-1',
          reporterProfileId: 'reporter-1',
          authorProfileId: 'author-1',
          reason: ContentReportReason.OTHER,
          notes: null,
          contentSnapshot: {},
          hideDrop: true,
          blockAuthor: true
        },
        {}
      )
    ).resolves.toBe(report);

    const transactionContext = expect.objectContaining({ connection });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(createReportSpy).toHaveBeenCalledWith(
      expect.any(Object),
      transactionContext
    );
    expect(blockProfileSpy).toHaveBeenCalledWith(
      'reporter-1',
      'author-1',
      transactionContext
    );
    expect(hideDropSpy).toHaveBeenCalledWith(
      'reporter-1',
      'drop-1',
      transactionContext
    );
  });

  it('locks the drop row and uses an explicit idempotent state upsert', async () => {
    const { db, executor } = createDb();
    const connection = {} as any;
    executor.oneOrNull.mockImplementation((sql: string) => {
      if (sql.includes('from drops')) {
        return Promise.resolve({ id: 'drop-1' });
      }
      if (sql.includes('content_moderation_drop_states')) {
        return Promise.resolve({ status: DropModerationStatus.VISIBLE });
      }
      return Promise.resolve(null);
    });

    await db.applyModeratorDropDecision(
      {
        dropId: 'drop-1',
        status: DropModerationStatus.AI_QUARANTINED,
        actorProfileId: 'moderator-1',
        reason: 'reviewed',
        action: 'MODERATOR_QUARANTINED',
        reportStatus: null
      },
      { connection }
    );

    const oneOrNullSql = executor.oneOrNull.mock.calls
      .map(([sql]) => sql as string)
      .join('\n');
    const executeSql = executor.execute.mock.calls
      .map(([sql]) => sql as string)
      .join('\n');
    expect(oneOrNullSql).toContain('for update');
    expect(executeSql).toContain(
      'on duplicate key update drop_id = values(drop_id)'
    );
    expect(executeSql).not.toContain('insert ignore');
  });
});
