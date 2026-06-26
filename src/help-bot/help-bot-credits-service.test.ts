import { HelpBotCreditEventType } from '@/entities/IHelpBotCreditEvent';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { RequestContext } from '@/request.context';
import { HelpBotCreditsService } from './help-bot-credits.service';
import { HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT } from './help-bot.config';

jest.mock('@/drops/participation-drops-over-vote-revocation', () => ({
  revokeRepBasedDropOverVotes: jest.fn()
}));
jest.mock('@/profileActivityLogs/profile-activity-logs.db', () => ({
  profileActivityLogsDb: {
    insert: jest.fn()
  }
}));

import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';

function createSqlExecutor({
  executeResults = [],
  oneOrNullResults = [],
  executeQueryResults = []
}: {
  readonly executeResults?: unknown[];
  readonly oneOrNullResults?: unknown[];
  readonly executeQueryResults?: unknown[][];
}) {
  const mutableExecuteResults = [...executeResults];
  const mutableOneOrNullResults = [...oneOrNullResults];
  const mutableExecuteQueryResults = [...executeQueryResults];
  const connection = { connection: {} };
  return {
    connection,
    executor: {
      execute: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT rating') && sql.includes('FOR UPDATE')) {
          return mutableExecuteQueryResults.shift() ?? [];
        }
        return mutableExecuteResults.shift() ?? { affectedRows: 1 };
      }),
      oneOrNull: jest.fn(async () => {
        return mutableOneOrNullResults.shift() ?? null;
      }),
      executeNativeQueriesInTransaction: jest.fn(async (callback) => {
        return await callback(connection);
      }),
      getAffectedRows: jest.fn((result: unknown) => {
        if (
          result != null &&
          typeof result === 'object' &&
          'affectedRows' in result
        ) {
          return Number((result as { affectedRows?: unknown }).affectedRows);
        }
        return 0;
      })
    }
  };
}

function createService({
  executeResults,
  executeQueryResults,
  oneOrNullResults,
  botProfileId = 'bot-profile'
}: {
  readonly executeResults?: unknown[];
  readonly executeQueryResults?: unknown[][];
  readonly oneOrNullResults?: unknown[];
  readonly botProfileId?: string | null;
}) {
  const { executor, connection } = createSqlExecutor({
    executeResults,
    executeQueryResults,
    oneOrNullResults
  });
  const profileResolver = {
    resolveBotProfileId: jest.fn().mockResolvedValue(botProfileId)
  };
  return {
    service: new HelpBotCreditsService(
      () => executor as never,
      profileResolver as never
    ),
    executor,
    connection,
    profileResolver
  };
}

describe('HelpBotCreditsService', () => {
  const ctx = {} as RequestContext;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('grants daily activity credits above the former balance cap', async () => {
    const { service, executor } = createService({
      executeResults: [{ affectedRows: 1 }],
      oneOrNullResults: [{ rating: 100 }]
    });

    const result = await service.grantDailyActivityCredits(
      { profileId: 'profile-1' },
      ctx
    );

    expect(result).toEqual({
      amountGranted: HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT,
      balance: 100 + HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT,
      alreadyGranted: false,
      botProfileMissing: false
    });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE ratings'),
      expect.objectContaining({ delta: HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT }),
      expect.anything()
    );
    expect(profileActivityLogsDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_id: 'bot-profile',
        target_id: 'profile-1',
        type: ProfileActivityLogType.RATING_EDIT,
        additional_data_1: 'REP',
        additional_data_2: 'Help6529 Credits',
        contents: JSON.stringify({
          old_rating: 100,
          new_rating: 100 + HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT,
          rating_matter: 'REP',
          rating_category: 'Help6529 Credits',
          change_reason: 'HELP_BOT_AUTOMATIC_GRANT'
        })
      }),
      expect.anything()
    );
  });

  it('scopes daily automatic grant dedupe to the current credit category', async () => {
    const { service, executor } = createService({
      executeResults: [{ affectedRows: 1 }],
      oneOrNullResults: [{ rating: 0 }]
    });

    await service.grantDailyActivityCredits(
      {
        profileId: 'profile-1',
        nowMillis: Date.UTC(2026, 5, 20)
      },
      ctx
    );

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO help_bot_credit_events'),
      expect.objectContaining({
        eventType: HelpBotCreditEventType.DAILY_ACTIVITY_GRANT,
        sourceId: 'Help6529 Credits:2026-06-20',
        amount: 0
      }),
      expect.anything()
    );
  });

  it('continues auto-granting above 100 credits', async () => {
    const { service, executor } = createService({
      executeResults: [{ affectedRows: 1 }],
      oneOrNullResults: [{ rating: 100 }]
    });

    const result = await service.grantDailyActivityCredits(
      { profileId: 'profile-1' },
      ctx
    );

    expect(result).toEqual({
      amountGranted: HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT,
      balance: 100 + HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT,
      alreadyGranted: false,
      botProfileMissing: false
    });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE ratings'),
      expect.objectContaining({ delta: HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT }),
      expect.anything()
    );
  });

  it('does not apply a duplicate automatic grant event', async () => {
    const { service, executor } = createService({
      executeResults: [{ affectedRows: 0 }],
      oneOrNullResults: [{ balance: 12 }]
    });

    const result = await service.grantDailyActivityCredits(
      { profileId: 'profile-1' },
      ctx
    );

    expect(result).toEqual({
      amountGranted: 0,
      balance: 12,
      alreadyGranted: true,
      botProfileMissing: false
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('declines a question charge when the category balance is too low', async () => {
    const { service, executor } = createService({
      executeQueryResults: [[{ rating: 0 }]]
    });

    const result = await service.chargeQuestionCredit(
      { profileId: 'profile-1', interactionId: 'interaction-1' },
      ctx
    );

    expect(result).toEqual({
      charged: false,
      balance: 0,
      botProfileMissing: false
    });
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('treats duplicate question charges as idempotent before checking balance', async () => {
    const { service, executor } = createService({
      executeQueryResults: [[{ rating: 0 }]],
      oneOrNullResults: [{ amount: -1 }]
    });

    const result = await service.chargeQuestionCredit(
      { profileId: 'profile-1', interactionId: 'interaction-1' },
      ctx
    );

    expect(result).toEqual({
      charged: true,
      balance: 0,
      botProfileMissing: false
    });
    expect(executor.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO help_bot_credit_events'),
      expect.anything(),
      expect.anything()
    );
  });

  it('uses the reserved credit category balance when checking spendable balance', async () => {
    const { service, executor } = createService({
      executeQueryResults: [[{ rating: 4 }, { rating: 2 }]]
    });

    const result = await service.chargeQuestionCredit(
      { profileId: 'profile-1', interactionId: 'interaction-1' },
      ctx
    );

    expect(result).toEqual({
      charged: true,
      balance: 5,
      botProfileMissing: false
    });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.not.stringContaining('rater_profile_id = :botProfileId'),
      expect.objectContaining({ profileId: 'profile-1' }),
      expect.anything()
    );
  });

  it('spends one credit for a chargeable question', async () => {
    const { service, executor } = createService({
      executeResults: [{ affectedRows: 1 }, { affectedRows: 1 }],
      executeQueryResults: [[{ rating: 3 }]]
    });

    const result = await service.chargeQuestionCredit(
      { profileId: 'profile-1', interactionId: 'interaction-1' },
      ctx
    );

    expect(result).toEqual({
      charged: true,
      balance: 2,
      botProfileMissing: false
    });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO help_bot_credit_events'),
      expect.objectContaining({
        eventType: HelpBotCreditEventType.QUESTION_SPEND,
        amount: -1
      }),
      expect.anything()
    );
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE ratings'),
      expect.objectContaining({ delta: -1 }),
      expect.anything()
    );
    expect(profileActivityLogsDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_id: 'bot-profile',
        target_id: 'profile-1',
        type: ProfileActivityLogType.RATING_EDIT,
        contents: JSON.stringify({
          old_rating: 3,
          new_rating: 2,
          rating_matter: 'REP',
          rating_category: 'Help6529 Credits',
          change_reason: 'HELP_BOT_QUESTION_SPEND'
        })
      }),
      expect.anything()
    );
  });

  it('refunds a previously charged question once', async () => {
    const { service, executor } = createService({
      executeResults: [{ affectedRows: 1 }],
      oneOrNullResults: [{ amount: -1 }, { rating: -1 }]
    });

    await expect(
      service.refundQuestionCredit(
        { profileId: 'profile-1', interactionId: 'interaction-1' },
        ctx
      )
    ).resolves.toBe(true);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT IGNORE INTO help_bot_credit_events'),
      expect.objectContaining({
        eventType: HelpBotCreditEventType.QUESTION_REFUND,
        amount: 1
      }),
      expect.anything()
    );
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE ratings'),
      expect.objectContaining({ delta: 1 }),
      expect.anything()
    );
    expect(profileActivityLogsDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_id: 'bot-profile',
        target_id: 'profile-1',
        type: ProfileActivityLogType.RATING_EDIT,
        contents: JSON.stringify({
          old_rating: -1,
          new_rating: 0,
          rating_matter: 'REP',
          rating_category: 'Help6529 Credits',
          change_reason: 'HELP_BOT_QUESTION_REFUND'
        })
      }),
      expect.anything()
    );
  });
});
