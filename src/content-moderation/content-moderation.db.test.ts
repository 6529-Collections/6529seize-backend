import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus,
  DropModerationStatus,
  ModeratedProfileStatus,
  PrePublicationCheckOutcome
} from '@/entities/IContentModeration';
import { BadRequestException } from '@/exceptions';
import { ContentModerationDb } from './content-moderation.db';
import {
  CONTENT_MODERATION_DROP_STATES_TABLE,
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE
} from '@/constants';
import { ActivityEventTargetType } from '@/entities/IActivityEvent';

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
    author_handle: 'author-handle',
    author_pfp: 'https://example.com/author.png',
    reporter_handle: 'reporter-handle',
    reporter_pfp: 'https://example.com/reporter.png',
    author_status: ModeratedProfileStatus.ACTIVE,
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
    recommendation_rank: 0,
    sort_timestamp: 200
  };
}

describe('ContentModerationDb', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps globally moderated content visible to its author only', async () => {
    const { db, executor } = createDb();
    executor.execute.mockImplementation((sql: string) => {
      if (sql.includes(CONTENT_MODERATION_DROP_STATES_TABLE)) {
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

  it('keeps moderated drop notifications available only to the author', async () => {
    const { db, executor } = createDb();
    executor.execute.mockResolvedValue([
      { drop_id: 'drop-1', author_id: 'author-1' }
    ]);

    await expect(
      db.filterUnavailableDropNotificationRows([
        {
          identity_id: 'author-1',
          related_drop_id: 'drop-1',
          related_drop_2_id: null
        },
        {
          identity_id: 'viewer-1',
          related_drop_id: 'drop-1',
          related_drop_2_id: null
        }
      ])
    ).resolves.toEqual([
      {
        identity_id: 'author-1',
        related_drop_id: 'drop-1',
        related_drop_2_id: null
      }
    ]);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(`left join drops d on d.id = s.drop_id`),
      { dropIds: ['drop-1'] },
      undefined
    );
  });

  it('does not persist environment-seeded moderator access during a read', async () => {
    const { db, executor } = createDb();

    await expect(db.isModerator('moderator-1', ['moderator-1'])).resolves.toBe(
      true
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.oneOrNull).not.toHaveBeenCalled();
  });

  it('checks for an open moderation report without loading the queue', async () => {
    const { db, executor } = createDb();
    executor.oneOrNull.mockResolvedValue({ has_open_report: 1 });

    await expect(db.hasOpenReports()).resolves.toBe(true);
    expect(executor.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining(`where status = '${ContentReportStatus.OPEN}'`),
      {},
      undefined
    );
  });

  it('returns and consumes a stable queue cursor matching its priority order', async () => {
    const { db, executor } = createDb();
    executor.execute.mockImplementation((sql: string) => {
      if (sql.includes('count(*) as report_count')) {
        return Promise.resolve([{ drop_id: 'drop-1', report_count: 2 }]);
      }
      return Promise.resolve([reportRow()]);
    });

    const firstPage = await db.getModerationQueue({ limit: 1 });
    expect(firstPage[0]?.cursor).toBe(`0.200.${REPORT_ID}`);
    expect(executor.execute.mock.calls[0]?.[0]).toContain(
      `where r.status = '${ContentReportStatus.OPEN}'`
    );
    expect(executor.execute.mock.calls[0]?.[0]).toContain(
      `p.external_id = r.author_profile_id`
    );
    expect(executor.execute.mock.calls[0]?.[0]).toContain(
      `reporter.external_id = r.reporter_profile_id`
    );
    expect(firstPage[0]).toEqual(
      expect.objectContaining({
        author_handle: 'author-handle',
        author_pfp: 'https://example.com/author.png',
        reporter_handle: 'reporter-handle',
        reporter_pfp: 'https://example.com/reporter.png',
        author_status: ModeratedProfileStatus.ACTIVE,
        report_count: 2
      })
    );
    expect(executor.execute.mock.calls[1]?.[0]).toContain(
      'and drop_id in (:dropIds)'
    );
    expect(executor.execute.mock.calls[1]?.[1]).toEqual({
      dropIds: ['drop-1']
    });

    await db.getModerationQueue({
      limit: 1,
      before: firstPage[0]!.cursor
    });
    expect(executor.execute).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('r.id < :beforeReportId'),
      expect.objectContaining({
        beforeRank: 0,
        beforeCreatedAt: 200,
        beforeReportId: REPORT_ID
      }),
      undefined
    );
  });

  it('does not query report counts for an empty moderation queue page', async () => {
    const { db, executor } = createDb();
    executor.execute.mockResolvedValue([]);

    await expect(db.getModerationQueue({ limit: 10 })).resolves.toEqual([]);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('includes actor profile context in drop audit history', async () => {
    const { db, executor } = createDb();
    executor.execute.mockResolvedValue([
      {
        id: 'audit-1',
        target_drop_id: 'drop-1',
        actor_profile_id: 'moderator-1',
        actor_handle: 'watcher',
        actor_pfp: 'https://example.com/watcher.png'
      }
    ]);

    await expect(
      db.getAuditHistoryForDrops(['drop-1', 'drop-1'])
    ).resolves.toEqual({
      'drop-1': [
        expect.objectContaining({
          actor_handle: 'watcher',
          actor_pfp: 'https://example.com/watcher.png'
        })
      ]
    });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(
        'left join profiles actor\n          on actor.external_id = audit.actor_profile_id'
      ),
      { dropIds: ['drop-1'] },
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
        deterministicSignal: null,
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
    const [sql] = executor.execute.mock.calls[0];
    expect(sql).toContain('deterministic_signal');
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
    jest.spyOn(db as any, 'assertReportAllowed').mockResolvedValue(undefined);
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

  it('rejects a second open report from the same profile for a drop', async () => {
    const { db, executor } = createDb();
    const connection = {} as any;
    executor.oneOrNull
      .mockResolvedValueOnce({ external_id: 'reporter-1' })
      .mockResolvedValueOnce({ id: 'existing-report' });
    const createReportSpy = jest.spyOn(db, 'createReport');

    await expect(
      db.createReportWithViewerActions(
        {
          dropId: 'drop-1',
          reporterProfileId: 'reporter-1',
          authorProfileId: 'author-1',
          reason: ContentReportReason.OTHER,
          notes: null,
          contentSnapshot: {},
          hideDrop: false,
          blockAuthor: false
        },
        { connection }
      )
    ).rejects.toThrow('already reported');
    expect(createReportSpy).not.toHaveBeenCalled();
    expect(executor.oneOrNull.mock.calls[0]?.[0]).toContain('for update');
  });

  it('withdraws an open report and restores an AI-only quarantine', async () => {
    const { db, executor } = createDb();
    const connection = {} as any;
    jest
      .spyOn(db as any, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (...args: unknown[]) => {
        const executable = args[0] as (value: any) => Promise<unknown>;
        return executable(connection);
      });
    executor.oneOrNull
      .mockResolvedValueOnce({ id: REPORT_ID })
      .mockResolvedValueOnce(null);
    jest.spyOn(db as any, 'insertAudit').mockResolvedValue(undefined);
    jest.spyOn(db as any, 'ensureAndLockDropState').mockResolvedValue({
      status: DropModerationStatus.AI_QUARANTINED,
      updated_by_profile_id: null
    });
    const writeStatusSpy = jest
      .spyOn(db as any, 'writeDropModerationStatus')
      .mockResolvedValue(undefined);

    await expect(
      db.withdrawOpenReport('reporter-1', 'drop-1', {})
    ).resolves.toBe(DropModerationStatus.VISIBLE);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(`status = '${ContentReportStatus.WITHDRAWN}'`),
      expect.objectContaining({ reportId: REPORT_ID }),
      { wrappedConnection: connection }
    );
    expect(writeStatusSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dropId: 'drop-1',
        status: DropModerationStatus.VISIBLE,
        previousStatus: DropModerationStatus.AI_QUARANTINED
      }),
      connection
    );
  });

  it('wraps personal moderation state and audit writes in a transaction', async () => {
    const { db, executor } = createDb();
    const connection = {} as any;
    const transactionSpy = jest
      .spyOn(db as any, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (...args: unknown[]) => {
        const executable = args[0] as (value: any) => Promise<unknown>;
        return executable(connection);
      });
    executor.oneOrNull
      .mockResolvedValueOnce({ external_id: 'blocked-1' })
      .mockResolvedValueOnce(null);

    await db.blockProfile('blocker-1', 'blocked-1', {});

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(CONTENT_MODERATION_PROFILE_BLOCKS_TABLE),
      expect.any(Object),
      { wrappedConnection: connection }
    );
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(`delete from ${IDENTITY_SUBSCRIPTIONS_TABLE}`),
      {
        blockerProfileId: 'blocker-1',
        blockedProfileId: 'blocked-1',
        targetType: ActivityEventTargetType.IDENTITY
      },
      { wrappedConnection: connection }
    );
  });

  it('deletes expired pre-publication checks by retention cutoff', async () => {
    const { db, executor } = createDb();
    executor.execute.mockResolvedValue({ affectedRows: 3 });

    await expect(db.deleteExpiredPrePublicationChecks(1234, 500)).resolves.toBe(
      3
    );
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringMatching(
        /where created_at < :olderThan\s+order by created_at asc\s+limit :batchSize/
      ),
      { olderThan: 1234, batchSize: 500 },
      undefined
    );
  });

  it('locks the drop row and uses an explicit idempotent state upsert', async () => {
    const { db, executor } = createDb();
    const connection = {} as any;
    executor.oneOrNull.mockImplementation((sql: string) => {
      if (sql.includes('from drops')) {
        return Promise.resolve({ id: 'drop-1' });
      }
      if (sql.includes(CONTENT_MODERATION_DROP_STATES_TABLE)) {
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
