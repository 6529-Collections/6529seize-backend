import { getCorsResponseOrigin, isCorsOriginAllowed } from './api-constants';

const ORIGINAL_ENV = { ...process.env };

describe('api CORS constants', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('only allows trusted production origins by default', () => {
    process.env.NODE_ENV = 'production';

    expect(isCorsOriginAllowed('https://6529.io')).toBe(true);
    expect(isCorsOriginAllowed('https://www.6529.io')).toBe(true);
    expect(isCorsOriginAllowed('https://app.6529.io')).toBe(true);
    expect(isCorsOriginAllowed('https://evil.example')).toBe(false);
    expect(isCorsOriginAllowed('http://localhost:3001')).toBe(false);
  });

  it('allows configured deployment origins and keeps manual headers bounded', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS =
      'https://staging.6529.io, https://preview.6529.io';

    expect(isCorsOriginAllowed('https://staging.6529.io')).toBe(true);
    expect(isCorsOriginAllowed('https://preview.6529.io')).toBe(true);
    expect(getCorsResponseOrigin('https://staging.6529.io')).toBe(
      'https://staging.6529.io'
    );
    expect(getCorsResponseOrigin('https://evil.example')).toBe(
      'https://6529.io'
    );
  });

  it('allows requests without an Origin header for same-origin and non-browser clients', () => {
    process.env.NODE_ENV = 'production';

    expect(isCorsOriginAllowed(undefined)).toBe(true);
    expect(getCorsResponseOrigin(undefined)).toBe('https://6529.io');
  });

  it('allows localhost origins outside production for local frontend development', () => {
    process.env.NODE_ENV = 'local';

    expect(isCorsOriginAllowed('http://localhost:3001')).toBe(true);
    expect(isCorsOriginAllowed('http://127.0.0.1:3001')).toBe(true);
  });
});
