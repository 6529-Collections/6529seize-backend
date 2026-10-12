import { redisFailureCategory } from './redis-recovery';

it.each([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH'
])('classifies %s as a recoverable network failure', (code) => {
  expect(redisFailureCategory(Object.assign(new Error(code), { code }))).toBe(
    'NETWORK'
  );
});
it('leaves authentication and unexpected object codes unclassified', () => {
  expect(redisFailureCategory(new Error('WRONGPASS'))).toBe('UNKNOWN');
  expect(
    redisFailureCategory(Object.assign(new Error('unknown'), { code: {} }))
  ).toBe('UNKNOWN');
});
