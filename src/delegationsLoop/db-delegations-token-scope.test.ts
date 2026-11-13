jest.mock('../db', () => ({ fetchLatestTDHBlockNumber: jest.fn() }));
jest.mock('../sql-executor', () => ({
  sqlExecutor: { execute: jest.fn() }
}));

import fc from 'fast-check';
import { MEMES_CONTRACT, USE_CASE_MINTING } from '@/constants';
import { sqlExecutor } from '../sql-executor';
import {
  delegationTokenScopeCondition,
  fetchProcessedDelegations
} from './db.delegations';

describe('delegationTokenScopeCondition', () => {
  it.each([undefined, null])(
    'limits to delegations for all tokens without a token (%s)',
    (tokenId) => {
      expect(delegationTokenScopeCondition(MEMES_CONTRACT, tokenId)).toEqual({
        sql: 'all_tokens = 1',
        params: {}
      });
    }
  );

  it('also allows the matching token in the requested collection', () => {
    expect(delegationTokenScopeCondition(MEMES_CONTRACT, 61)).toEqual({
      sql: '(all_tokens = 1 OR (collection = :scopeCollection AND token_id = :scopeTokenId))',
      params: { scopeCollection: MEMES_CONTRACT, scopeTokenId: 61 }
    });
  });

  it('treats token 0 as a token context', () => {
    expect(delegationTokenScopeCondition(MEMES_CONTRACT, 0).params).toEqual({
      scopeCollection: MEMES_CONTRACT,
      scopeTokenId: 0
    });
  });

  it('returns a param for every placeholder in its SQL', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(fc.nat(), { nil: undefined }),
        (collection, tokenId) => {
          const { sql, params } = delegationTokenScopeCondition(
            collection,
            tokenId
          );
          const placeholders = Array.from(
            sql.matchAll(/:(\w+)/g),
            (match) => match[1]
          );
          expect(new Set(placeholders)).toEqual(new Set(Object.keys(params)));
        }
      )
    );
  });
});

describe('fetchProcessedDelegations', () => {
  beforeEach(() => {
    jest.mocked(sqlExecutor.execute).mockReset().mockResolvedValue([]);
  });

  function rankedSubquery(sql: string): string {
    return sql.slice(sql.indexOf('FROM'), sql.indexOf(') AS ranked'));
  }

  it('filters the token scope before ranking delegations', async () => {
    await fetchProcessedDelegations(MEMES_CONTRACT, USE_CASE_MINTING);

    const [sql, params] = jest.mocked(sqlExecutor.execute).mock.calls[0];
    expect(rankedSubquery(sql)).toContain('AND all_tokens = 1');
    expect(params).not.toHaveProperty('scopeTokenId');
  });

  it('passes the token in question', async () => {
    await fetchProcessedDelegations(
      MEMES_CONTRACT,
      USE_CASE_MINTING,
      ['0xABC'],
      7
    );

    const [sql, params] = jest.mocked(sqlExecutor.execute).mock.calls[0];
    expect(rankedSubquery(sql)).toContain('token_id = :scopeTokenId');
    expect(params).toEqual(
      expect.objectContaining({
        scopeCollection: MEMES_CONTRACT,
        scopeTokenId: 7,
        wallets: ['0xabc']
      })
    );
  });
});
