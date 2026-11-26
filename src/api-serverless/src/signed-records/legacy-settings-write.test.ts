import { legacySettingsWrite } from './legacy-settings-write';
import { personalRecordsStateDb } from '@/personal-records/personal-records-state.db';

describe('legacySettingsWrite', () => {
  const env = process.env.PERSONAL_RECORDS_MODE;
  afterEach(() => {
    process.env.PERSONAL_RECORDS_MODE = env;
    jest.restoreAllMocks();
  });

  const run = () =>
    new Promise<unknown>((resolve) => {
      legacySettingsWrite({}, {}, (error?: unknown) => resolve(error ?? null));
    });

  const statusOf = (error: unknown) =>
    error === null
      ? null
      : `${(error as { getStatusCode(): number }).getStatusCode()} ${(error as { code: string }).code}`;

  it('passes in legacy and shadow, 409 in primary, 503 while frozen', async () => {
    const read = jest
      .spyOn(personalRecordsStateDb, 'read')
      .mockResolvedValue({ frozen: false, importOrder: null });
    process.env.PERSONAL_RECORDS_MODE = 'legacy';
    expect(statusOf(await run())).toBeNull();
    process.env.PERSONAL_RECORDS_MODE = 'shadow';
    expect(statusOf(await run())).toBeNull();
    process.env.PERSONAL_RECORDS_MODE = 'primary';
    expect(statusOf(await run())).toBe('409 PERSONAL_RECORDS_REQUIRED');
    read.mockResolvedValue({ frozen: true, importOrder: null });
    expect(statusOf(await run())).toBe('503 PERSONAL_SETTINGS_PAUSED');
  });
});
