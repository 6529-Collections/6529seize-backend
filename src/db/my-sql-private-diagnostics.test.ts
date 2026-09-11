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
    'artwork_documentation_assets',
    'profile_cms_agent_grants',
    'profile_cms_agent_proposals',
    'profile_cms_agent_events'
  ])('omits bound and inline private values for %s', async (table) => {
    jest.spyOn(Time.prototype, 'diffFromNow').mockReturnValue(Time.seconds(2));
    const failure = Object.assign(
      new Error('private-contact@example.test in SQL error'),
      {
        code: 'ER_DUP_ENTRY',
        sql: `INSERT INTO ${table} VALUES ('private-image.tif')`
      }
    );
    const connection = {
      config: {},
      query: (_query: unknown, callback: (error: Error) => void) =>
        callback(failure),
      release: jest.fn()
    } as unknown as PoolConnection;
    const rejected = await execSQLWithParams(
      `INSERT INTO ${table} (filename) VALUES ('private-image.tif')`,
      connection,
      true,
      { contact: 'private-contact@example.test' }
    ).catch((caught: unknown) => caught);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(rejected).not.toBe(failure);
    expect(String(rejected)).not.toContain('private-contact@example.test');
    expect(JSON.stringify(rejected)).not.toContain('private-image.tif');
    expect(rejected).not.toHaveProperty('sql');
    expect(warn).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    const diagnostics = JSON.stringify([warn.mock.calls, error.mock.calls]);
    expect(diagnostics).not.toContain('private-contact@example.test');
    expect(diagnostics).not.toContain('private-image.tif');
    expect(diagnostics).not.toContain('INSERT INTO');
    expect(connection.release).toHaveBeenCalled();
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
