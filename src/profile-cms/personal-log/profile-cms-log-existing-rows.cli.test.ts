import { main } from '@/profile-cms/personal-log/profile-cms-log-existing-rows.cli';

describe('profile-cms:log-existing-rows', () => {
  function deps(logExistingRows: () => Promise<number>) {
    const written: string[] = [];
    return {
      written,
      deps: {
        privateLog: { logExistingRows: jest.fn(logExistingRows) },
        inDb: <T>(fn: () => Promise<T>) => fn(),
        write: (text: string) => {
          written.push(text);
        }
      }
    };
  }

  it('logs the existing rows once and says how many', async () => {
    const run = deps(async () => 7);
    expect(await main([], run.deps)).toBe(7);
    expect(run.deps.privateLog.logExistingRows).toHaveBeenCalledTimes(1);
    expect(run.written).toEqual(['logged 7 existing profile site rows\n']);
  });

  it('fails while the flag is off, as the log refuses', async () => {
    const run = deps(async () => {
      throw new Error(
        'Turn FEATURE_PROFILE_CMS_PERSONAL_LOG on before logging existing rows'
      );
    });
    await expect(main([], run.deps)).rejects.toThrow(
      'FEATURE_PROFILE_CMS_PERSONAL_LOG'
    );
  });

  it('prints usage and refuses arguments', async () => {
    const run = deps(async () => 0);
    expect(await main(['--help'], run.deps)).toBeNull();
    expect(run.written[0]).toContain('FEATURE_PROFILE_CMS_PERSONAL_LOG');
    await expect(main(['--now'], run.deps)).rejects.toThrow(
      'Unexpected arguments'
    );
    expect(run.deps.privateLog.logExistingRows).not.toHaveBeenCalled();
  });
});
