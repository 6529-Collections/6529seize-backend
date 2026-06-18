import { seizeSettings } from './seize-settings';

const ORIGINAL_ENV = {
  AUTH_STRUCTURED_SIGNATURES_REQUIRED:
    process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED,
  SESSION_V2_MIGRATION_DEADLINE: process.env.SESSION_V2_MIGRATION_DEADLINE
};

describe('seizeSettings auth rollout settings', () => {
  afterEach(() => {
    process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED =
      ORIGINAL_ENV.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
    process.env.SESSION_V2_MIGRATION_DEADLINE =
      ORIGINAL_ENV.SESSION_V2_MIGRATION_DEADLINE;
  });

  it('returns silent auth defaults when rollout env vars are unset', () => {
    delete process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED;
    delete process.env.SESSION_V2_MIGRATION_DEADLINE;

    expect(seizeSettings().auth).toEqual({
      structured_signatures_required: false,
      session_v2_migration_deadline: null
    });
  });

  it('returns backend-controlled auth rollout values', () => {
    process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED = 'true';
    process.env.SESSION_V2_MIGRATION_DEADLINE = '2026-06-25T00:00:00.000Z';

    expect(seizeSettings().auth).toEqual({
      structured_signatures_required: true,
      session_v2_migration_deadline: '2026-06-25T00:00:00.000Z'
    });
  });

  it('rejects a migration deadline without an explicit timezone', () => {
    process.env.SESSION_V2_MIGRATION_DEADLINE = '2026-06-25T00:00:00';

    expect(() => seizeSettings()).toThrow(
      'SESSION_V2_MIGRATION_DEADLINE must be an ISO datetime with timezone'
    );
  });
});
