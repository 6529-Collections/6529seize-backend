import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import {
  EthPriceRepairError,
  priceFailureDetails,
  repairCause
} from './eth-price-failure';

it('retains a work-budget failure for adaptive sizing and safe diagnostics', () => {
  const cause = new SqlExecutionBudgetExceededError(
    'SQL_BUDGET_EXCEEDED',
    'WORK',
    'NOT_SENT'
  );
  cause.connectionDestroyed = true;
  const error = new EthPriceRepairError('update-transactions', cause);
  expect(repairCause(error)).toBe(cause);
  expect(priceFailureDetails(error)).toMatchObject({
    stage: 'update-transactions',
    code: 'SQL_BUDGET_EXCEEDED',
    phase: 'WORK',
    commitOutcome: 'NOT_SENT',
    connectionDestroyed: true
  });
});

it('excludes raw database and HTTP payloads from failure summaries', () => {
  const error = Object.assign(new Error('private message'), {
    code: 'ER_LOCK_WAIT_TIMEOUT',
    sql: 'private SQL',
    parameters: ['secret'],
    response: { data: 'private response' }
  });
  expect(priceFailureDetails(error)).toEqual({
    stage: undefined,
    code: 'ER_LOCK_WAIT_TIMEOUT'
  });
  expect(repairCause(error)).toBe(error);
  expect(priceFailureDetails({ code: 'private message' }).code).toBe('UNKNOWN');
});
