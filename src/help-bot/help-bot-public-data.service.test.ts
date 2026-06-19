import { MEMES_CONTRACT } from '@/constants';
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
  it('compiles a semantic season-count plan to backend-owned SQL', () => {
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'meme_cards',
        operation: 'count',
        filters: { season: '1' }
      })
    ).toEqual(
      expect.objectContaining({
        queryId: 'meme_cards.count',
        compiledSql:
          'SELECT COUNT(*) AS meme_count FROM memes_extended_data m WHERE m.season = :season LIMIT 1',
        params: { season: 1 },
        title: 'Meme Cards in SZN1',
        canonicalPath: '/the-memes?szn=1'
      })
    );
  });

  it('compiles a card metric lookup with the MEMES contract guard', () => {
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'meme_cards',
        operation: 'value',
        metric: 'tdh_rate',
        filters: { meme: 1 }
      })
    ).toEqual(
      expect.objectContaining({
        queryId: 'meme_cards.value.tdh_rate',
        compiledSql:
          'SELECT m.meme, m.meme_name, n.hodl_rate AS tdh_rate FROM memes_extended_data m JOIN nfts n ON n.id = m.id AND n.contract = :memesContract WHERE m.meme = :meme LIMIT 1',
        params: { memesContract: MEMES_CONTRACT, meme: 1 },
        title: 'Meme #1 TDH Rate',
        canonicalPath: '/the-memes/1'
      })
    );
  });

  it('compiles top-N metric plans without accepting model SQL', () => {
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'meme_cards',
        operation: 'max',
        metric: 'edition_size',
        filters: { season: 2 },
        limit: 3
      })
    ).toEqual(
      expect.objectContaining({
        queryId: 'meme_cards.max.edition_size',
        compiledSql:
          'SELECT m.meme, m.meme_name, m.edition_size AS edition_size FROM memes_extended_data m WHERE m.season = :season ORDER BY m.edition_size DESC, m.meme ASC LIMIT 3',
        params: { season: 2 },
        title: 'Highest Meme Card Edition Size in SZN2',
        canonicalPath: '/the-memes?szn=2'
      })
    );
  });

  it('declines unknown plan fields and invalid numeric filters', () => {
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'raw_sql',
        operation: 'value',
        filters: { rawSql: 'SELECT id FROM profiles' }
      })
    ).toBeNull();
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'meme_cards',
        operation: 'count',
        filters: { season: 0 }
      })
    ).toBeNull();
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'meme_cards',
        operation: 'value',
        metric: 'tdh_rate',
        filters: { meme: '1; DROP TABLE profiles' }
      })
    ).toBeNull();
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'meme_cards',
        operation: 'count',
        filters: { season: 1, rawSql: 'SELECT id FROM profiles' }
      })
    ).toBeNull();
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'meme_cards',
        operation: 'count',
        filters: 'season = 1'
      })
    ).toBeNull();
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'meme_cards',
        operation: 'count; DELETE FROM users',
        filters: { season: 1 }
      })
    ).toBeNull();
    expect(
      buildHelpBotPublicDataQuery({
        entity: 'meme_cards',
        operation: 'value',
        metric: 'tdh_rate FROM users',
        filters: { meme: 1 }
      })
    ).toBeNull();
  });
});

describe('HelpBotPublicDataService', () => {
  it('plans, validates, executes, and renders public data answers', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        entity: 'meme_cards',
        operation: 'count',
        filters: { season: 1 }
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
      queryId: 'meme_cards.count'
    });
    expect(db.execute).toHaveBeenCalledWith(
      withStatementTimeoutHint(
        'SELECT COUNT(*) AS meme_count FROM memes_extended_data m WHERE m.season = :season LIMIT 1'
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
        entity: 'raw_sql',
        operation: 'value',
        filters: { rawSql: 'SELECT id FROM profiles' }
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

  it('rejects SQL-shaped filters and never treats them as executable text', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        entity: 'tdh_global',
        operation: 'latest',
        metric: 'total_tdh',
        filters: { rawSql: 'SELECT id FROM profiles' }
      }),
      renderPublicDataAnswer: jest.fn()
    };
    const db = new TestSqlExecutor();
    const service = new HelpBotPublicDataService(llm, () => db);

    await expect(
      service.answer({ question: 'total tdh?' })
    ).resolves.toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('ignores unexpected SQL fields and executes only compiled backend SQL', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        entity: 'meme_cards',
        operation: 'count',
        filters: { season: 1 },
        sql: 'SELECT id FROM users'
      }),
      renderPublicDataAnswer: jest.fn().mockResolvedValue('SZN1 has 47 cards.')
    };
    const db = new TestSqlExecutor();
    db.execute.mockResolvedValue([{ meme_count: 47 }]);
    const service = new HelpBotPublicDataService(llm, () => db);

    await expect(
      service.answer({ question: 'how many memes are in szn1?' })
    ).resolves.toEqual({
      answer:
        'SZN1 has 47 cards.\n\nMore info: https://6529.io/the-memes?szn=1',
      queryId: 'meme_cards.count'
    });
    expect(db.execute).toHaveBeenCalledWith(
      withStatementTimeoutHint(
        'SELECT COUNT(*) AS meme_count FROM memes_extended_data m WHERE m.season = :season LIMIT 1'
      ),
      { season: 1 },
      { forcePool: DbPoolName.READ }
    );
  });

  it('executes a latest global TDH plan through the read pool', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        entity: 'tdh_global',
        operation: 'latest',
        metric: 'total_tdh',
        filters: {}
      }),
      renderPublicDataAnswer: jest.fn().mockResolvedValue('Total TDH is 123.')
    };
    const db = new TestSqlExecutor();
    db.execute.mockResolvedValue([{ total_tdh: 123 }]);
    const service = new HelpBotPublicDataService(llm, () => db);

    await expect(service.answer({ question: 'total tdh?' })).resolves.toEqual({
      answer: 'Total TDH is 123.\n\nMore info: https://6529.io/network/tdh',
      queryId: 'tdh_global.latest.total_tdh'
    });
    expect(db.execute).toHaveBeenCalledWith(
      withStatementTimeoutHint(
        'SELECT total_boosted_tdh AS total_tdh, date, block FROM latest_tdh_global_history LIMIT 1'
      ),
      undefined,
      { forcePool: DbPoolName.READ }
    );
  });

  it('declines empty public data rows without rendering an answer', async () => {
    const llm: HelpBotPublicDataLlm = {
      planPublicDataQuery: jest.fn().mockResolvedValue({
        entity: 'tdh_global',
        operation: 'latest',
        metric: 'total_tdh'
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
        entity: 'meme_cards',
        operation: 'avg',
        metric: 'edition_size',
        filters: {}
      }),
      renderPublicDataAnswer: jest.fn()
    };
    const db = new TestSqlExecutor();
    db.execute.mockResolvedValue([{ edition_size: null }]);
    const service = new HelpBotPublicDataService(llm, () => db);

    await expect(
      service.answer({ question: 'average edition size?' })
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
        entity: 'tdh_global',
        operation: 'latest',
        metric: 'total_tdh'
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
