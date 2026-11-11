import { formatNamedParameters } from '@/db/sql-named-parameters';
import {
  NativeCompetitionRuntimeRepository,
  PRIORITY_OUTBOX_EVENT_TYPES
} from './native-competition-runtime.repository';

function repositoryCapturingSql() {
  const execute = jest.fn().mockResolvedValue([]);
  const db = {
    execute,
    executeNativeQueriesInTransaction: async <T>(
      run: (connection: unknown) => Promise<T>
    ) => run({})
  };
  return {
    repository: new NativeCompetitionRuntimeRepository(() => db as never),
    execute
  };
}

describe('priority outbox claim', () => {
  it('binds the priority event types as a flat list of strings, like other list parameters', async () => {
    const { repository, execute } = repositoryCapturingSql();

    await repository.claimPriorityOutbox({ now: 5, limit: 100 });

    const [sql, params] = execute.mock.calls[0];
    expect(params.priorityEventTypes).toEqual([
      'COMPETITION_DECISION_COMPLETED',
      'COMPETITION_OUTCOME_CREATED',
      'COMPETITION_ENTRY_STATUS_CHANGED'
    ]);
    expect(params.priorityEventTypes).toEqual([...PRIORITY_OUTBOX_EVENT_TYPES]);
    expect(formatNamedParameters(sql, params).replace(/\s+/g, ' ')).toContain(
      "in ('COMPETITION_DECISION_COMPLETED', 'COMPETITION_OUTCOME_CREATED', 'COMPETITION_ENTRY_STATUS_CHANGED') order by created_at asc, id asc limit 100 for update skip locked"
    );
  });

  it('keeps the ordinary claim free of the event type filter', async () => {
    const { repository, execute } = repositoryCapturingSql();

    await repository.claimOutbox({ now: 5, limit: 100 });

    const [sql, params] = execute.mock.calls[0];
    expect(sql).not.toContain('event_type');
    expect(params).not.toHaveProperty('priorityEventTypes');
  });
});
