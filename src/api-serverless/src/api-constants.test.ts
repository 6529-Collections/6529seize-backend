import {
  corsOptions,
  getCorsOptionsForRequest,
  isWebAuthCredentialOriginAllowed
} from './api-constants';

describe('api CORS constants', () => {
  const originalOrigins = process.env.AUTH_WEB_CREDENTIAL_ORIGINS;

  afterEach(() => {
    if (originalOrigins === undefined) {
      delete process.env.AUTH_WEB_CREDENTIAL_ORIGINS;
      return;
    }
    process.env.AUTH_WEB_CREDENTIAL_ORIGINS = originalOrigins;
  });

  it('keeps public API CORS open for browser-based third-party apps', () => {
    expect(corsOptions.origin).toBe('*');
    expect(corsOptions).not.toHaveProperty('credentials');
  });

  it('uses exact credentialed CORS for trusted web auth origins', () => {
    process.env.AUTH_WEB_CREDENTIAL_ORIGINS =
      'https://6529.io, https://staging.6529.io';

    expect(
      getCorsOptionsForRequest('/api/auth/session-refresh', 'https://6529.io')
    ).toMatchObject({
      origin: 'https://6529.io',
      credentials: true
    });
  });

  it('does not expose credentialed auth routes to untrusted browser origins', () => {
    process.env.AUTH_WEB_CREDENTIAL_ORIGINS = 'https://6529.io';

    expect(
      getCorsOptionsForRequest(
        '/api/auth/session-refresh',
        'https://evil.example'
      )
    ).toMatchObject({
      origin: false
    });
  });

  it('keeps non-auth API routes wildcard even when credential origins are set', () => {
    process.env.AUTH_WEB_CREDENTIAL_ORIGINS = 'https://6529.io';

    expect(
      getCorsOptionsForRequest('/api/drops', 'https://6529.io')
    ).toMatchObject({
      origin: '*'
    });
  });

  it('normalizes configured web auth credential origins', () => {
    process.env.AUTH_WEB_CREDENTIAL_ORIGINS = 'https://6529.io/path';

    expect(isWebAuthCredentialOriginAllowed('https://6529.io')).toBe(true);
    expect(isWebAuthCredentialOriginAllowed('https://6529.io/other')).toBe(
      true
    );
    expect(isWebAuthCredentialOriginAllowed('https://www.6529.io')).toBe(false);
  });
});
