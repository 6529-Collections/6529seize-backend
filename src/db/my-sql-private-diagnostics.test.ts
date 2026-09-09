import { PoolConnection } from 'mysql';
import { execSQLWithParams } from './my-sql.helpers';
import { Time } from '../time';

const warn = jest.fn();
const error = jest.fn();
jest.mock('../logging', () => ({
  Logger: {
    get: () => ({
      warn: (...args: unknown[]) => warn(...args),
      error: (...args: unknown[]) => error(...args)
    })
  }
}));

describe('private artwork SQL diagnostics', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    warn.mockClear();
    error.mockClear();
  });
  it('omits bound and inline private values from slow and failed queries', async () => {
    jest.spyOn(Time.prototype, 'diffFromNow').mockReturnValue(Time.seconds(2));
    const failure = new Error('private-contact@example.test in SQL error');
    const connection = {
      config: {},
      query: (_query: unknown, callback: (error: Error) => void) =>
        callback(failure),
      release: jest.fn()
    } as unknown as PoolConnection;
    await expect(
      execSQLWithParams(
        "INSERT INTO artwork_documentation_assets (filename) VALUES ('private-image.tif')",
        connection,
        true,
        { contact: 'private-contact@example.test' }
      )
    ).rejects.toBe(failure);
    expect(warn).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    const diagnostics = JSON.stringify([warn.mock.calls, error.mock.calls]);
    expect(diagnostics).not.toContain('private-contact@example.test');
    expect(diagnostics).not.toContain('private-image.tif');
    expect(diagnostics).not.toContain('INSERT INTO');
    expect(connection.release).toHaveBeenCalled();
  });
});
