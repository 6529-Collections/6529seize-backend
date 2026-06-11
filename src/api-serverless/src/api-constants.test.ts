import { corsOptions } from './api-constants';

describe('api CORS constants', () => {
  it('keeps public API CORS open for browser-based third-party apps', () => {
    expect(corsOptions.origin).toBe('*');
    expect(corsOptions).not.toHaveProperty('credentials');
  });
});
