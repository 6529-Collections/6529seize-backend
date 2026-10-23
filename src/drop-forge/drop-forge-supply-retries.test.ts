import { reportActionFailure } from './drop-forge.groups';
import { LaunchRecord, SupplyEvidenceError } from './drop-forge.types';
import { testLaunchData } from './drop-forge.test-fixtures';
it('backs supply disagreements off at one, five and fifteen minutes while retaining outstanding work', () => {
  const record: LaunchRecord = {
    id: 'launch',
    revision: 1,
    state: 'RUNNING',
    error: null,
    updated_at: 0,
    data: testLaunchData()
  };
  const action = record.data.actions.at(-1)!;
  const error = new SupplyEvidenceError(
    { status: 'WAITING', checked_at: 1, rpc_total: 10, db_total: 9 },
    'mismatch'
  );
  for (const [index, delay] of Array.from([60, 300, 900, 900].entries())) {
    reportActionFailure(record, action, 1000, error.message, error);
    expect(action.retry_at).toBe(1000 + delay);
    expect(action.attempt_count).toBe(index + 1);
    expect(record.data.events.at(-1)?.error).toBe(true);
  }
  expect(action.state).toBe('PENDING');
});
