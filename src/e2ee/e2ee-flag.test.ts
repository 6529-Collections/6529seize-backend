import {
  e2eeEntriesPerGroupPerHour,
  e2eeTrustAndSafetyGroupId,
  isE2eeAttachmentsEnabled,
  isE2eeEnabled
} from '@/e2ee/e2ee-flag';

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

describe('isE2eeAttachmentsEnabled', () => {
  it.each([
    [{ E2EE_ATTACHMENTS_ENABLED: 'true', NODE_ENV: 'production' }, true],
    [{ E2EE_ATTACHMENTS_ENABLED: 'false', NODE_ENV: 'development' }, false],
    [{ E2EE_ATTACHMENTS_ENABLED: 'FALSE', NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'local' }, true],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'production' }, true],
    [{ E2EE_ATTACHMENTS_ENABLED: 'no', NODE_ENV: 'production' }, true],
    [{}, true]
  ])('resolves %j to %s', (env, expected) => {
    expect(isE2eeAttachmentsEnabled(env)).toBe(expected);
  });
});

describe('e2eeEntriesPerGroupPerHour', () => {
  it.each([
    [{ NODE_ENV: 'production' }, 12],
    [{}, 12],
    [{ NODE_ENV: 'development' }, 30],
    [{ NODE_ENV: 'local' }, 30],
    [{ NODE_ENV: 'production', E2EE_ENTRIES_PER_GROUP_PER_HOUR: '20' }, 20],
    [{ NODE_ENV: 'development', E2EE_ENTRIES_PER_GROUP_PER_HOUR: ' 5 ' }, 5],
    [{ NODE_ENV: 'production', E2EE_ENTRIES_PER_GROUP_PER_HOUR: '0' }, 12],
    [{ NODE_ENV: 'production', E2EE_ENTRIES_PER_GROUP_PER_HOUR: '1001' }, 12],
    [{ NODE_ENV: 'production', E2EE_ENTRIES_PER_GROUP_PER_HOUR: '2.5' }, 12],
    [{ NODE_ENV: 'production', E2EE_ENTRIES_PER_GROUP_PER_HOUR: 'many' }, 12]
  ])('resolves %j to %s', (env, expected) => {
    expect(e2eeEntriesPerGroupPerHour(env)).toBe(expected);
  });
});

describe('e2eeTrustAndSafetyGroupId', () => {
  it.each([
    [{}, null],
    [{ E2EE_TRUST_AND_SAFETY_GROUP_ID: '' }, null],
    [{ E2EE_TRUST_AND_SAFETY_GROUP_ID: '   ' }, null],
    [{ E2EE_TRUST_AND_SAFETY_GROUP_ID: ' group-1 ' }, 'group-1']
  ])('resolves %j to %s', (env, expected) => {
    expect(e2eeTrustAndSafetyGroupId(env)).toBe(expected);
  });
});
