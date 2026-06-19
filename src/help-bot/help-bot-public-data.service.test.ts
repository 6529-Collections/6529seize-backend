import { DbPoolName } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';
import { HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS } from './help-bot.config';
import {
  HelpBotPublicDataLlm,
  HelpBotPublicDataService,
  buildHelpBotPublicDataQuery
} from './help-bot-public-data.service';

class TestSqlExecutor extends SqlExecutor {
  public readonly execute = jest.fn();
  public readonly executeNativeQueriesInTransaction = jest.fn();
}

function withStatementTimeoutHint(sql: string): string {
  return sql.replace(
    /^SELECT\b/i,
    `SELECT /*+ MAX_EXECUTION_TIME(${HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS}) */`
  );
}

describe('buildHelpBotPublicDataQuery', () => {
  it('builds fixed SQL from a typed query plan', () => {
    expect(
      buildHelpBotPublicDataQuery({
        queryId: 'memes_in_season_count',
        params: { season: '1' }
      })
    ).toEqual(
      expect.objectContaining({
        queryId: 'memes_in_season_count',
        templateSql:
          'SELECT COUNT(*) AS meme_count FROM memes_extended_data WHERE season = :season LIMIT 10',
        params: { season: 1 },
        title: 'Meme Cards in SZN1',
        canonicalPath: '/the-memes?szn=1'
      })
    );
  });

  it('declines unknown query ids and invalid numeric params', () => {
    expect(
      buildHelpBotPublicDataQuery({
        queryId: 'raw_sql',
        params: { rawSql: 'SELECT id FROM profiles' }
      })
    ).toBeNull();
    expect(
      buildHelpBotPublicDataQuery({
        queryId: 'memes_in_season_count',
        params: { season: 0 }
      })
    ).toBeNull();
    expect(
      buildHelpBotPublicDataQuery({
        queryId: 'meme_tdh_rate',
        params: { meme: '1; DROP TABLE profiles' }
      })
    ).toBeNull();
  });
});

describe('HelpBotPublicDataService', () => {
  it('plans, validates, executes, and renders public data answers', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        queryId: 'memes_in_season_count',
        params: { season: 1 }
      }),
      renderPublicDataAnswer: jest
        .fn()
        .mockResolvedValue(
          'SZN1 has 47 Meme Cards.\n\nMore info: https://6529.io/the-memes?szn=1'
        )
    };
    const db = new TestSqlExecutor();
    db.execute.mockResolvedValue([{ meme_count: 47 }]);
    const service = new HelpBotPublicDataService(llm, () => db);

    await expect(
      service.answer({ question: 'how many memes are in szn1?' })
    ).resolves.toEqual({
      answer:
        'SZN1 has 47 Meme Cards.\n\nMore info: https://6529.io/the-memes?szn=1',
      queryId: 'memes_in_season_count'
    });
    expect(db.execute).toHaveBeenCalledWith(
      withStatementTimeoutHint(
        'SELECT COUNT(*) AS meme_count FROM memes_extended_data WHERE season = :season LIMIT 10'
      ),
      { season: 1 },
      { forcePool: DbPoolName.READ }
    );
    expect(llm.renderPublicDataAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Meme Cards in SZN1',
        canonicalUrl: 'https://6529.io/the-memes?szn=1'
      })
    );
  });

  it('does not call the planner for non-data questions', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn(),
      renderPublicDataAnswer: jest.fn()
    };
    const service = new HelpBotPublicDataService(
      llm,
      () => new TestSqlExecutor()
    );

    await expect(
      service.answer({ question: 'what is TDH?' })
    ).resolves.toBeNull();
    expect(llm.planPublicDataQuery).not.toHaveBeenCalled();
  });

  it('declines unsafe planner output without executing SQL', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        queryId: 'raw_sql',
        params: { rawSql: 'SELECT id FROM profiles' }
      }),
      renderPublicDataAnswer: jest.fn()
    };
    const db = new TestSqlExecutor();
    const service = new HelpBotPublicDataService(llm, () => db);

    await expect(
      service.answer({ question: 'highest tdh rate?' })
    ).resolves.toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('declines empty public data rows without rendering an answer', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        queryId: 'total_tdh'
      }),
      renderPublicDataAnswer: jest.fn()
    };
    const db = new TestSqlExecutor();
    db.execute.mockResolvedValue([]);
    const service = new HelpBotPublicDataService(llm, () => db);

    await expect(
      service.answer({ question: 'total tdh?' })
    ).resolves.toBeNull();
    expect(llm.renderPublicDataAnswer).not.toHaveBeenCalled();
  });

  it('declines all-null aggregate rows without rendering an answer', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        queryId: 'highest_tdh_rate'
      }),
      renderPublicDataAnswer: jest.fn()
    };
    const db = new TestSqlExecutor();
    db.execute.mockResolvedValue([{ highest_tdh_rate: null }]);
    const service = new HelpBotPublicDataService(llm, () => db);

    await expect(
      service.answer({ question: 'highest tdh rate?' })
    ).resolves.toBeNull();
    expect(llm.renderPublicDataAnswer).not.toHaveBeenCalled();
  });

  it('declines planner failures without blocking help-index fallback', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockRejectedValue(new Error('bedrock')),
      renderPublicDataAnswer: jest.fn()
    };
    const db = new TestSqlExecutor();
    const service = new HelpBotPublicDataService(llm, () => db);

    await expect(
      service.answer({ question: 'highest tdh rate?' })
    ).resolves.toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('falls back to deterministic row rendering when LLM wording fails', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        queryId: 'total_tdh'
      }),
      renderPublicDataAnswer: jest.fn().mockRejectedValue(new Error('bedrock'))
    };
    const db = new TestSqlExecutor();
    db.execute.mockResolvedValue([{ total_tdh: 123456 }]);
    const service = new HelpBotPublicDataService(llm, () => db);

    const answer = await service.answer({ question: 'total tdh?' });

    expect(answer?.answer).toContain('Total TDH: 123,456');
    expect(answer?.answer).toContain('https://6529.io/network/tdh');
  });
});
