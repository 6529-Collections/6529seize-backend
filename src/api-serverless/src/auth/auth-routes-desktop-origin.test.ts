jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));

import { isDesktopSessionOriginAllowed } from './auth.routes';

describe('desktop auth origin validation', () => {
  it.each([
    'http://localhost:6529',
    'http://127.0.0.1:6529',
    'http://[::1]:6529'
  ])('allows loopback HTTP origins with a port: %s', (origin) => {
    expect(isDesktopSessionOriginAllowed(origin)).toBe(true);
  });

  it.each([
    null,
    '',
    'http://localhost',
    'https://localhost:6529',
    'http://localhost.evil.example:6529',
    'http://192.168.0.10:6529',
    'https://6529.io',
    'not-a-url'
  ])('rejects non-desktop origins: %s', (origin) => {
    expect(isDesktopSessionOriginAllowed(origin)).toBe(false);
  });
});
