import { PoolConnection } from 'mysql';
import { execSQLWithParams } from './my-sql.helpers';
import { Time } from '../time';
import { Logger } from '../logging';

const warn = jest.fn();
const error = jest.fn();

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
    }
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
