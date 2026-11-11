jest.mock('../db', () => ({ fetchLatestTDHBlockNumber: jest.fn() }));
jest.mock('../sql-executor', () => ({
  sqlExecutor: { execute: jest.fn() }
}));

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
      expect(delegationTokenScopeCondition(tokenId)).toEqual({
        sql: 'all_tokens = 1',
        params: {}
      });
    }
  );

  it('also allows the matching token in the requested collection', () => {
    expect(delegationTokenScopeCondition(61)).toEqual({
      sql: '(all_tokens = 1 OR (collection = :collection AND token_id = :scopeTokenId))',
      params: { scopeTokenId: 61 }
    });
  });

  it('treats token 0 as a token context', () => {
    expect(delegationTokenScopeCondition(0).params).toEqual({
      scopeTokenId: 0
    });
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
      expect.objectContaining({ scopeTokenId: 7, wallets: ['0xabc'] })
    );
  });
});
