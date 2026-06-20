import { HelpBotCreditEventType } from '@/entities/IHelpBotCreditEvent';
import { RequestContext } from '@/request.context';
import { HelpBotCreditsService } from './help-bot-credits.service';

jest.mock('@/drops/participation-drops-over-vote-revocation', () => ({
  revokeRepBasedDropOverVotes: jest.fn()
}));

function createSqlExecutor({
  executeResults = [],
  oneOrNullResults = []
}: {
  readonly executeResults?: unknown[];
  readonly oneOrNullResults?: unknown[];
}) {
  const mutableExecuteResults = [...executeResults];
  const mutableOneOrNullResults = [...oneOrNullResults];
  const connection = { connection: {} };
  return {
    connection,
    executor: {
      execute: jest.fn(async () => {
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
  oneOrNullResults,
  botProfileId = 'bot-profile'
}: {
  readonly executeResults?: unknown[];
  readonly oneOrNullResults?: unknown[];
  readonly botProfileId?: string | null;
}) {
  const { executor, connection } = createSqlExecutor({
    executeResults,
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

  it('caps automatic grants at the configured system balance cap', async () => {
    const { service, executor } = createService({
      executeResults: [{ affectedRows: 1 }],
      oneOrNullResults: [{ rating: 49 }, { balance: 49 }]
    });

    const result = await service.grantDailyActivityCredits(
      { profileId: 'profile-1' },
      ctx
    );

    expect(result).toEqual({
      amountGranted: 1,
      balance: 50,
      alreadyGranted: false,
      botProfileMissing: false
    });
    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE ratings'),
      expect.objectContaining({ delta: 1 }),
      expect.anything()
    );
  });

  it('does not auto-grant above the current category balance cap', async () => {
    const { service, executor } = createService({
      executeResults: [{ affectedRows: 1 }],
      oneOrNullResults: [{ rating: 0 }, { balance: 50 }]
    });

    const result = await service.grantDailyActivityCredits(
      { profileId: 'profile-1' },
      ctx
    );

    expect(result).toEqual({
      amountGranted: 0,
      balance: 50,
      alreadyGranted: false,
      botProfileMissing: false
    });
    expect(executor.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE ratings'),
      expect.anything(),
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
      oneOrNullResults: [{ rating: 0 }, { balance: 0 }]
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
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('spends one credit for a chargeable question', async () => {
    const { service, executor } = createService({
      executeResults: [{ affectedRows: 1 }, { affectedRows: 1 }],
      oneOrNullResults: [{ rating: 0 }, { balance: 3 }]
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
  });
});
