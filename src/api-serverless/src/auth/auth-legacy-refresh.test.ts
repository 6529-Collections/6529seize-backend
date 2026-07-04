import {
  assertLegacyRefreshEnabled,
  isLegacyRefreshEnabled
} from './auth-legacy-refresh';

describe('auth legacy refresh configuration', () => {
  afterEach(() => {
    delete process.env.AUTH_LEGACY_REFRESH_DISABLED;
  });

  it('enables legacy refresh unless explicitly disabled', () => {
    delete process.env.AUTH_LEGACY_REFRESH_DISABLED;
    expect(isLegacyRefreshEnabled()).toBe(true);

    process.env.AUTH_LEGACY_REFRESH_DISABLED = 'false';
    expect(isLegacyRefreshEnabled()).toBe(true);

    process.env.AUTH_LEGACY_REFRESH_DISABLED = 'true';
    expect(isLegacyRefreshEnabled()).toBe(false);
  });

  it('throws a deliberate gone response when legacy refresh is disabled', () => {
    process.env.AUTH_LEGACY_REFRESH_DISABLED = 'true';

    expect(() => assertLegacyRefreshEnabled()).toThrow(
      'Legacy refresh token redemption is disabled'
    );
    try {
      assertLegacyRefreshEnabled();
    } catch (error) {
      expect(
        (error as { getStatusCode?: () => number }).getStatusCode?.()
      ).toBe(410);
    }
  });
});
