import {
  corsOptions,
  getCorsOptionsForRequest,
  isWebAuthCredentialOriginAllowed
} from './api-constants';

describe('api CORS constants', () => {
  const originalEnv = {
    AUTH_WEB_CREDENTIAL_ORIGINS: process.env.AUTH_WEB_CREDENTIAL_ORIGINS,
    WEB_APP_ADDITIONAL_ORIGINS: process.env.WEB_APP_ADDITIONAL_ORIGINS,
    WEB_APP_ORIGIN: process.env.WEB_APP_ORIGIN
  };

  beforeEach(() => {
    delete process.env.AUTH_WEB_CREDENTIAL_ORIGINS;
    delete process.env.WEB_APP_ADDITIONAL_ORIGINS;
    delete process.env.WEB_APP_ORIGIN;
  });

  afterEach(() => {
    restoreEnv('AUTH_WEB_CREDENTIAL_ORIGINS');
    restoreEnv('WEB_APP_ADDITIONAL_ORIGINS');
    restoreEnv('WEB_APP_ORIGIN');
  });

  it('keeps public API CORS open for browser-based third-party apps', () => {
    expect(corsOptions.origin).toBe('*');
    expect(corsOptions).not.toHaveProperty('credentials');
  });

  it('uses exact credentialed CORS for the default production web origin on production API', () => {
    expect(
      getCorsOptionsForRequest(
        '/api/auth/session-refresh',
        'https://6529.io',
        'api.6529.io'
      )
    ).toMatchObject({
      origin: 'https://6529.io',
      credentials: true
    });
  });

  it('uses exact credentialed CORS for the legacy desktop connection-share bridge', () => {
    expect(
      getCorsOptionsForRequest(
        '/api/auth/connection-share/legacy-desktop',
        'https://6529.io',
        'api.6529.io'
      )
    ).toMatchObject({
      origin: 'https://6529.io',
      credentials: true
    });
  });

  it('matches default API hosts when the Host header includes a port', () => {
    expect(
      getCorsOptionsForRequest(
        '/api/auth/session-refresh',
        'https://6529.io',
        'api.6529.io:443'
      )
    ).toMatchObject({
      origin: 'https://6529.io',
      credentials: true
    });
  });

  it('uses exact credentialed CORS for the default staging web origin on staging API', () => {
    expect(
      getCorsOptionsForRequest(
        '/api/auth/session-refresh',
        'https://staging.6529.io',
        'api.staging.6529.io'
      )
    ).toMatchObject({
      origin: 'https://staging.6529.io',
      credentials: true
    });
  });

  it('does not allow staging web credentials on the production API by default', () => {
    expect(
      getCorsOptionsForRequest(
        '/api/auth/session-refresh',
        'https://staging.6529.io',
        'api.6529.io'
      )
    ).toMatchObject({
      origin: false
    });
  });

  it('does not expose credentialed auth routes to untrusted browser origins', () => {
    expect(
      getCorsOptionsForRequest(
        '/api/auth/session-refresh',
        'https://evil.example',
        'api.6529.io'
      )
    ).toMatchObject({
      origin: false
    });
  });

  it('keeps non-auth API routes wildcard even when credential origins are set', () => {
    expect(
      getCorsOptionsForRequest('/api/drops', 'https://6529.io', 'api.6529.io')
    ).toMatchObject({
      origin: '*'
    });
  });

  it('adds WEB_APP_ORIGIN to the allowed credentialed origins', () => {
    process.env.WEB_APP_ORIGIN = 'https://custom.6529.io/path';

    expect(
      isWebAuthCredentialOriginAllowed(
        'https://custom.6529.io/other',
        'api.custom.6529.io'
      )
    ).toBe(true);
  });

  it('adds WEB_APP_ADDITIONAL_ORIGINS without removing defaults', () => {
    process.env.WEB_APP_ADDITIONAL_ORIGINS =
      'https://preview.6529.io/path, https://www.6529.io';

    expect(
      isWebAuthCredentialOriginAllowed('https://preview.6529.io', 'api.6529.io')
    ).toBe(true);
    expect(
      isWebAuthCredentialOriginAllowed('https://6529.io', 'api.6529.io')
    ).toBe(true);
  });

  it('keeps deprecated AUTH_WEB_CREDENTIAL_ORIGINS as an additive compatibility alias', () => {
    process.env.AUTH_WEB_CREDENTIAL_ORIGINS = 'https://legacy.6529.io/path';

    expect(
      isWebAuthCredentialOriginAllowed('https://legacy.6529.io', 'api.6529.io')
    ).toBe(true);
    expect(
      isWebAuthCredentialOriginAllowed('https://www.6529.io', 'api.6529.io')
    ).toBe(false);
  });

  function restoreEnv(envName: keyof typeof originalEnv): void {
    const originalValue = originalEnv[envName];
    if (originalValue === undefined) {
      delete process.env[envName];
      return;
    }
    process.env[envName] = originalValue;
  }
});
