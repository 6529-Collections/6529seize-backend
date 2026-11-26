import {
  assertLegacySettingsWrite,
  assertRecordsWrite,
  personalRecordsMode
} from './personal-records.mode';

const state = (frozen: boolean) => ({
  read: async () => ({ frozen, importOrder: null })
});

const codeOf = async (run: () => Promise<unknown>): Promise<string | null> => {
  try {
    await run();
    return null;
  } catch (error) {
    const e = error as { code?: string; getStatusCode?: () => number };
    return `${e.getStatusCode?.()} ${e.code}`;
  }
};

describe('personal records mode', () => {
  it('is legacy unless the env names another mode', () => {
    expect(personalRecordsMode({})).toBe('legacy');
    expect(personalRecordsMode({ PERSONAL_RECORDS_MODE: 'Shadow ' })).toBe(
      'shadow'
    );
    expect(personalRecordsMode({ PERSONAL_RECORDS_MODE: 'primary' })).toBe(
      'primary'
    );
    expect(personalRecordsMode({ PERSONAL_RECORDS_MODE: 'records' })).toBe(
      'legacy'
    );
  });

  it('lets legacy routes write in legacy and shadow, and refuses them in primary', async () => {
    const open = state(false);
    expect(await codeOf(() => assertLegacySettingsWrite(open, {}))).toBeNull();
    expect(
      await codeOf(() =>
        assertLegacySettingsWrite(open, { PERSONAL_RECORDS_MODE: 'shadow' })
      )
    ).toBeNull();
    expect(
      await codeOf(() =>
        assertLegacySettingsWrite(open, { PERSONAL_RECORDS_MODE: 'primary' })
      )
    ).toBe('409 PERSONAL_RECORDS_REQUIRED');
  });

  it('takes records in primary, and in shadow only as companions of a legacy write', async () => {
    const open = state(false);
    expect(await codeOf(() => assertRecordsWrite(open, true, {}))).toBe(
      '409 PERSONAL_RECORDS_OFF'
    );
    expect(
      await codeOf(() =>
        assertRecordsWrite(open, false, { PERSONAL_RECORDS_MODE: 'shadow' })
      )
    ).toBe('409 PERSONAL_RECORDS_SHADOW');
    expect(
      await assertRecordsWrite(open, true, { PERSONAL_RECORDS_MODE: 'shadow' })
    ).toBe('shadow');
    expect(
      await assertRecordsWrite(open, false, {
        PERSONAL_RECORDS_MODE: 'primary'
      })
    ).toBe('primary');
  });

  it('refuses every settings write while the shared state is frozen', async () => {
    const frozen = state(true);
    const env = { PERSONAL_RECORDS_MODE: 'primary' };
    expect(await codeOf(() => assertLegacySettingsWrite(frozen, env))).toBe(
      '503 PERSONAL_SETTINGS_PAUSED'
    );
    expect(await codeOf(() => assertRecordsWrite(frozen, true, env))).toBe(
      '503 PERSONAL_SETTINGS_PAUSED'
    );
  });
});
