import { PoolConnection } from 'mysql';
import { execSQLWithParams } from './my-sql.helpers';
import { Time } from '../time';
import { Logger } from '../logging';
import { SqlExecutionBudgetExceededError } from './sql-execution-budget';

const warn = jest.fn();
const error = jest.fn();
const membershipRuntimeTables = [
  'membership_refresh_runs',
  'membership_refresh_targets',
  'membership_runtime_checkpoints',
  'membership_runtime_fixture_control',
  'membership_source_states',
  'membership_source_jobs',
  'membership_group_versions',
  'membership_publications',
  'membership_generation_members'
] as const;

describe('private SQL diagnostics', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(warn);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(error);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    warn.mockClear();
    error.mockClear();
  });
  it.each([
    {
      table: 'content_moderation_items',
      inline: 'rejected-about-text',
      bound: 'private-review-reason'
    },
    {
      table: 'content_moderation_evaluations',
      inline: 'reported-private-text',
      bound: 'provider-rationale'
    },
    {
      table: 'content_moderation_reports',
      inline: 'reported-content',
      bound: 'reporter-note'
    },
    {
      table: 'abusiveness_detection_results',
      inline: 'rejected-category',
      bound: 'private-assessment'
    },
    {
      table: 'profile_cms_agent_grants',
      inline: 'private-candidate-copy',
      bound: 'private-grant-value'
    },
    {
      table: 'profile_cms_agent_proposals',
      inline: 'private-candidate-copy',
      bound: 'private-grant-value'
    },
    {
      table: 'profile_cms_agent_events',
      inline: 'private-candidate-copy',
      bound: 'private-grant-value'
    },
    {
      table: 'artwork_documentation_assets',
      inline: 'private-image.tif',
      bound: 'private-contact@example.test'
    },
    {
      table: 'market_depth_events',
      inline: 'private-provider-payload',
      bound: 'private-order-payload'
    },
    ...membershipRuntimeTables.map((table) => ({
      table,
      inline: 'private-inline-membership-authority-token',
      bound: 'private-bound-membership-authority-token'
    }))
  ])(
    'omits bound and inline private values from slow and failed $table queries',
    async ({ table, inline, bound }) => {
      jest
        .spyOn(Time.prototype, 'diffFromNow')
        .mockReturnValue(Time.seconds(2));
      const failure = Object.assign(new Error(`${bound} in SQL error`), {
        code: 'ER_DUP_ENTRY',
        sql: `INSERT INTO ${table} VALUES ('${inline}')`
      });
      const connection = {
        config: {},
        query: (_query: unknown, callback: (error: Error) => void) =>
          callback(failure),
        release: jest.fn()
      } as unknown as PoolConnection;
      const rejected = await execSQLWithParams(
        `INSERT INTO ${table} (payload) VALUES ('${inline}')`,
        connection,
        true,
        { payload: bound }
      ).catch((caught: unknown) => caught);
      expect(rejected).toBeInstanceOf(Error);
      expect(rejected).toMatchObject({ code: 'ER_DUP_ENTRY' });
      expect(rejected).not.toBe(failure);
      expect(String(rejected)).not.toContain(bound);
      expect(JSON.stringify(rejected)).not.toContain(inline);
      expect(rejected).not.toHaveProperty('sql');
      expect(warn).toHaveBeenCalled();
      expect(error).toHaveBeenCalled();
      const diagnostics = JSON.stringify([warn.mock.calls, error.mock.calls]);
      expect(diagnostics).not.toContain(bound);
      expect(diagnostics).not.toContain(inline);
      expect(diagnostics).not.toContain('INSERT INTO');
      expect(connection.release).toHaveBeenCalled();
    }
  );
  it.each([
    'membership_refresh_runs',
    'membership_runtime_fixture_control',
    'membership_runtime_checkpoints'
  ])('redacts tokens from a slow successful %s query', async (table) => {
    jest.spyOn(Time.prototype, 'diffFromNow').mockReturnValue(Time.seconds(2));
    const inline = 'private-inline-lease-token';
    const bound = 'private-bound-control-token';
    const connection = {
      config: {},
      query: (
        _query: unknown,
        callback: (error: null, rows: unknown[]) => void
      ) => callback(null, [{ accepted: true }]),
      release: jest.fn()
    } as unknown as PoolConnection;
    await expect(
      execSQLWithParams(
        `SELECT id FROM \`${table}\` WHERE lease_token='${inline}' AND id=:id`,
        connection,
        true,
        { id: bound }
      )
    ).resolves.toEqual([{ accepted: true }]);
    expect(warn).toHaveBeenCalledWith(
      'SQL query took 2000 ms to execute: [private membership runtime query]'
    );
    expect(error).not.toHaveBeenCalled();
    const diagnostics = JSON.stringify(warn.mock.calls);
    expect(diagnostics).not.toContain(inline);
    expect(diagnostics).not.toContain(bound);
    expect(diagnostics).not.toContain('SELECT');
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
  it.each(['NOT_SENT', 'UNKNOWN', 'ACKNOWLEDGED'] as const)(
    'preserves the original safe budget error and %s commit outcome',
    async (commitOutcome) => {
      jest
        .spyOn(Time.prototype, 'diffFromNow')
        .mockReturnValue(Time.seconds(2));
      const failure = new SqlExecutionBudgetExceededError(
        'SQL_STATEMENT_FAILED',
        'COMMIT',
        commitOutcome,
        'ER_LOCK_NOWAIT'
      );
      failure.connectionDestroyed = true;
      const connection = {
        config: {},
        query: (_query: unknown, callback: (error: Error) => void) =>
          callback(failure)
      } as unknown as PoolConnection;
      const rejected = await execSQLWithParams(
        "UPDATE membership_refresh_runs SET lease_token=:token WHERE run_id='private-inline-run-token'",
        connection,
        false,
        { token: 'private-bound-lease-token' }
      ).catch((caught: unknown) => caught);
      expect(rejected).toBe(failure);
      expect(rejected).toBeInstanceOf(SqlExecutionBudgetExceededError);
      expect(rejected).toMatchObject({
        code: 'SQL_STATEMENT_FAILED',
        phase: 'COMMIT',
        commitOutcome,
        connectionDestroyed: true,
        serverCode: 'ER_LOCK_NOWAIT'
      });
      expect(error).toHaveBeenCalledWith(
        `SQL_STATEMENT_FAILED phase=COMMIT commit=${commitOutcome}`
      );
      const diagnostics = JSON.stringify([warn.mock.calls, error.mock.calls]);
      expect(diagnostics).not.toContain('private-inline-run-token');
      expect(diagnostics).not.toContain('private-bound-lease-token');
      expect(diagnostics).not.toContain('UPDATE');
    }
  );
  it.each([
    { code: 'UNKNOWN_CODE_PLEASE_REPORT', errno: 3572 },
    { code: 'ER_LOCK_NOWAIT' }
  ])(
    'preserves only the known membership NOWAIT condition %j',
    async (fields) => {
      const failure = Object.assign(new Error('private-lease-token'), fields, {
        sql: 'private SQL containing a lease',
        cause: new Error('private driver cause')
      });
      const connection = {
        config: {},
        query: (_query: unknown, callback: (error: Error) => void) =>
          callback(failure)
      } as unknown as PoolConnection;
      const rejected = await execSQLWithParams(
        'SELECT id FROM membership_runtime_checkpoints FOR UPDATE NOWAIT',
        connection,
        false
      ).catch((caught: unknown) => caught);
      expect(rejected).not.toBe(failure);
      expect(rejected).toMatchObject({
        message: 'Private membership runtime database operation failed',
        code: 'ER_LOCK_NOWAIT',
        errno: 3572
      });
      expect(rejected).not.toHaveProperty('sql');
      expect(rejected).not.toHaveProperty('cause');
      expect(String(rejected)).not.toContain('private-lease-token');
    }
  );
  it('does not copy arbitrary membership driver fields', async () => {
    const failure = Object.assign(new Error('private-driver-token'), {
      code: 'UNKNOWN_CODE_PLEASE_REPORT',
      errno: 99999,
      sql: 'private SQL',
      cause: new Error('private cause')
    });
    const connection = {
      config: {},
      query: (_query: unknown, callback: (error: Error) => void) =>
        callback(failure)
    } as unknown as PoolConnection;
    const rejected = await execSQLWithParams(
      'SELECT id FROM membership_runtime_fixture_control',
      connection,
      false
    ).catch((caught: unknown) => caught);
    expect(rejected).toBeInstanceOf(Error);
    for (const field of ['code', 'errno', 'sql', 'cause'])
      expect(rejected).not.toHaveProperty(field);
    expect(String(rejected)).not.toContain('private-driver-token');
  });
  it('preserves the original error for other database queries', async () => {
    const failure = new Error('ordinary database error');
    const connection = {
      config: {},
      query: (_query: unknown, callback: (error: Error) => void) =>
        callback(failure),
      release: jest.fn()
    } as unknown as PoolConnection;
    await expect(
      execSQLWithParams('SELECT id FROM profiles', connection, true)
    ).rejects.toBe(failure);
  });
});
