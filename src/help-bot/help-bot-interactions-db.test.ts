import {
  HelpBotInteractionStatus,
  HelpBotInteractionTriggerType
} from '@/entities/IHelpBotInteraction';
import { RequestContext } from '@/request.context';
import {
  HelpBotInteractionRow,
  HelpBotInteractionsDb
} from './help-bot-interactions.db';
import { Time } from '@/time';
import { HELP_BOT_ANSWERING_LEASE_MS } from './help-bot.config';
import { ConnectionWrapper } from '@/sql-executor';

describe('HelpBotInteractionsDb', () => {
  const ctx = {} as RequestContext;
  const transactionConnection: ConnectionWrapper<string> = {
    connection: 'transaction-connection'
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createInteraction(
    overrides: Partial<HelpBotInteractionRow> = {}
  ): HelpBotInteractionRow {
    return {
      id: 'interaction-1',
      trigger_drop_id: 'trigger-drop',
      target_drop_id: 'trigger-drop',
      wave_id: 'wave-1',
      author_id: 'author-1',
      trigger_type: HelpBotInteractionTriggerType.MENTION,
      question: 'what is tdh',
      parent_bot_drop_id: null,
      bot_reply_drop_id: null,
      status: HelpBotInteractionStatus.SEEN,
      knowledge_version: 'v1',
      failure_reason: null,
      created_at: 1,
      updated_at: 1,
      answer_started_at: null,
      completed_at: null,
      ...overrides
    };
  }

  function createSqlExecutor({
    executeResult,
    row = createInteraction()
  }: {
    readonly executeResult: unknown;
    readonly row?: HelpBotInteractionRow | null;
  }) {
    return {
      execute: jest.fn().mockResolvedValue(executeResult),
      executeNativeQueriesInTransaction: jest.fn(
        async <T>(
          executable: (connection: ConnectionWrapper<any>) => Promise<T>
        ) => executable(transactionConnection)
      ),
      oneOrNull: jest.fn().mockResolvedValue(row),
      getAffectedRows: jest.fn((result: unknown) => {
        if (
          result != null &&
          typeof result === 'object' &&
          'affectedRows' in result
        ) {
          return Number((result as { affectedRows?: unknown }).affectedRows);
        }
        return Array.isArray(result) && typeof result[1] === 'number'
          ? result[1]
          : 0;
      })
    };
  }

  function createDb(sqlExecutor: ReturnType<typeof createSqlExecutor>) {
    return new HelpBotInteractionsDb(() => sqlExecutor as never);
  }

  it('treats API mysql insert metadata arrays with affected rows as created', async () => {
    const sqlExecutor = createSqlExecutor({ executeResult: [0, 1] });
    const db = createDb(sqlExecutor);

    const result = await db.insertSeen(
      {
        triggerDropId: 'trigger-drop',
        targetDropId: 'trigger-drop',
        waveId: 'wave-1',
        authorProfileId: 'author-1',
        triggerType: HelpBotInteractionTriggerType.MENTION,
        question: 'what is tdh',
        parentBotDropId: null
      },
      ctx
    );

    expect(result.created).toBe(true);
    expect(sqlExecutor.getAffectedRows).toHaveBeenCalledWith([0, 1]);
  });

  it('inserts and reads back seen interactions on one transactional connection', async () => {
    const sqlExecutor = createSqlExecutor({ executeResult: [0, 1] });
    const db = createDb(sqlExecutor);

    await db.insertSeen(
      {
        triggerDropId: 'trigger-drop',
        targetDropId: 'trigger-drop',
        waveId: 'wave-1',
        authorProfileId: 'author-1',
        triggerType: HelpBotInteractionTriggerType.MENTION,
        question: 'what is tdh',
        parentBotDropId: null
      },
      ctx
    );

    expect(sqlExecutor.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(
      1
    );
    expect(sqlExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO help_bot_interactions'),
      expect.anything(),
      { wrappedConnection: transactionConnection }
    );
    expect(sqlExecutor.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('WHERE trigger_drop_id = :triggerDropId'),
      { triggerDropId: 'trigger-drop' },
      { wrappedConnection: transactionConnection }
    );
  });

  it('treats API mysql insert metadata arrays without affected rows as duplicates', async () => {
    const sqlExecutor = createSqlExecutor({ executeResult: [0, 0] });
    const db = createDb(sqlExecutor);

    const result = await db.insertSeen(
      {
        triggerDropId: 'trigger-drop',
        targetDropId: 'trigger-drop',
        waveId: 'wave-1',
        authorProfileId: 'author-1',
        triggerType: HelpBotInteractionTriggerType.MENTION,
        question: 'what is tdh',
        parentBotDropId: null
      },
      ctx
    );

    expect(result.created).toBe(false);
  });

  it('claims interactions when API mysql update metadata has affected rows', async () => {
    const claimedRow = createInteraction({
      status: HelpBotInteractionStatus.ANSWERING
    });
    const sqlExecutor = createSqlExecutor({
      executeResult: [0, 1],
      row: claimedRow
    });
    const db = createDb(sqlExecutor);

    await expect(db.claimForAnswering('interaction-1', ctx)).resolves.toBe(
      claimedRow
    );
  });

  it('allows stale answering interactions to be reclaimed', async () => {
    const now = 1_000_000;
    jest.spyOn(Time, 'currentMillis').mockReturnValue(now);
    const claimedRow = createInteraction({
      answer_started_at: 100,
      status: HelpBotInteractionStatus.ANSWERING
    });
    const sqlExecutor = createSqlExecutor({
      executeResult: [0, 1],
      row: claimedRow
    });
    const db = createDb(sqlExecutor);

    await expect(db.claimForAnswering('interaction-1', ctx)).resolves.toBe(
      claimedRow
    );

    expect(sqlExecutor.execute).toHaveBeenCalledWith(
      expect.stringContaining('answer_started_at < :leaseStartedBefore'),
      expect.objectContaining({
        answeringStatus: HelpBotInteractionStatus.ANSWERING,
        seenStatus: HelpBotInteractionStatus.SEEN,
        leaseStartedBefore: now - HELP_BOT_ANSWERING_LEASE_MS,
        now
      }),
      expect.anything()
    );
  });

  it('does not claim interactions when API mysql update metadata has no affected rows', async () => {
    const sqlExecutor = createSqlExecutor({ executeResult: [0, 0] });
    const db = createDb(sqlExecutor);

    await expect(
      db.claimForAnswering('interaction-1', ctx)
    ).resolves.toBeNull();
  });
});
