import { DbPoolName } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';
import { HELP_BOT_PUBLIC_DATA_QUERY_TIMEOUT_MS } from './help-bot.config';
import {
  HelpBotPublicDataLlm,
  HelpBotPublicDataService,
  validateHelpBotPublicDataSql
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

describe('validateHelpBotPublicDataSql', () => {
  it('allows a single SELECT against public help-bot tables', () => {
    expect(
      validateHelpBotPublicDataSql(
        'SELECT COUNT(*) AS meme_count FROM memes_extended_data WHERE season = 1'
      )
    ).toBe(
      'SELECT COUNT(*) AS meme_count FROM memes_extended_data WHERE season = 1 LIMIT 10'
    );
  });

  it('adds a safe limit to non-aggregate list queries', () => {
    expect(
      validateHelpBotPublicDataSql(
        'SELECT meme, meme_name FROM memes_extended_data ORDER BY meme ASC'
      )
    ).toBe(
      'SELECT meme, meme_name FROM memes_extended_data ORDER BY meme ASC LIMIT 10'
    );
  });

  it('rejects non-public tables and mutations', () => {
    expect(() =>
      validateHelpBotPublicDataSql('SELECT id FROM profiles LIMIT 1')
    ).toThrow('disallowed table profiles');
    expect(() =>
      validateHelpBotPublicDataSql('DELETE FROM memes_extended_data')
    ).toThrow('SELECT');
  });

  it('rejects risky SQL shapes from planner output', () => {
    expect(() =>
      validateHelpBotPublicDataSql('SELECT * FROM memes_extended_data LIMIT 1')
    ).toThrow('explicit columns');
    expect(() =>
      validateHelpBotPublicDataSql(
        'SELECT meme FROM memes_extended_data # comment'
      )
    ).toThrow('single uncommented statement');
    expect(() =>
      validateHelpBotPublicDataSql(
        'SELECT meme FROM memes_extended_data UNION SELECT id FROM nfts'
      )
    ).toThrow('disallowed keyword');
    expect(() =>
      validateHelpBotPublicDataSql(
        'SELECT meme FROM memes_extended_data, nfts LIMIT 1'
      )
    ).toThrow('explicit JOIN syntax');
    expect(() =>
      validateHelpBotPublicDataSql(
        'SELECT meme FROM (SELECT id FROM profiles) p LIMIT 1'
      )
    ).toThrow('subqueries');
    expect(() =>
      validateHelpBotPublicDataSql(
        'SELECT m.meme FROM memes_extended_data m JOIN profiles p ON p.id = m.id LIMIT 1'
      )
    ).toThrow('disallowed table profiles');
    expect(() =>
      validateHelpBotPublicDataSql(
        'SELECT meme FROM memes_extended_data LIMIT 0, 100'
      )
    ).toThrow('exceeds max 10');
  });
});

describe('HelpBotPublicDataService', () => {
  it('plans, validates, executes, and renders public data answers', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        sql: 'SELECT COUNT(*) AS meme_count FROM memes_extended_data WHERE season = 1',
        title: 'Meme Cards in SZN1',
        canonicalPath: '/the-memes?szn=1'
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
      sql: 'SELECT COUNT(*) AS meme_count FROM memes_extended_data WHERE season = 1 LIMIT 10'
    });
    expect(db.execute).toHaveBeenCalledWith(
      withStatementTimeoutHint(
        'SELECT COUNT(*) AS meme_count FROM memes_extended_data WHERE season = 1 LIMIT 10'
      ),
      undefined,
      { forcePool: DbPoolName.READ }
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
        sql: 'SELECT * FROM profiles LIMIT 1',
        title: 'Unsafe',
        canonicalPath: '/open-data'
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
        sql: 'SELECT total_boosted_tdh AS total_tdh FROM latest_tdh_global_history LIMIT 1',
        title: 'Total TDH',
        canonicalPath: '/network/tdh'
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
        sql: 'SELECT MAX(hodl_rate) AS highest_tdh_rate FROM nfts LIMIT 1',
        title: 'Highest TDH Rate',
        canonicalPath: '/the-memes'
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
        sql: 'SELECT total_boosted_tdh AS total_tdh FROM latest_tdh_global_history LIMIT 1',
        title: 'Total TDH',
        canonicalPath: '/network/tdh'
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
