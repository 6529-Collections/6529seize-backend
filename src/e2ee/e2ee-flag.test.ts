import { isE2eeEnabled } from '@/e2ee/e2ee-flag';

describe('isE2eeEnabled', () => {
  it.each([
    [{ E2EE_DMS_ENABLED: 'true', NODE_ENV: 'production' }, true],
    [{ E2EE_DMS_ENABLED: 'TRUE', NODE_ENV: 'production' }, true],
    [{ E2EE_DMS_ENABLED: 'false', NODE_ENV: 'local' }, false],
    [{ E2EE_DMS_ENABLED: 'false', NODE_ENV: 'development' }, false],
    [{ NODE_ENV: 'local' }, true],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'prod' }, false],
    [{}, false],
    [{ E2EE_DMS_ENABLED: 'yes', NODE_ENV: 'production' }, false],
    [{ E2EE_DMS_ENABLED: '', NODE_ENV: 'development' }, true]
  ])('resolves %j to %s', (env, expected) => {
    expect(isE2eeEnabled(env)).toBe(expected);
  });
});
