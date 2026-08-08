import { seizeSettings } from './seize-settings';

const ORIGINAL_ENV = {
  AUTH_STRUCTURED_SIGNATURES_REQUIRED:
    process.env.AUTH_STRUCTURED_SIGNATURES_REQUIRED,
  SESSION_V2_MIGRATION_DEADLINE: process.env.SESSION_V2_MIGRATION_DEADLINE,
  STREAM_REVIEW_ACCESS_MODE: process.env.STREAM_REVIEW_ACCESS_MODE,
  STREAM_REVIEW_ACCESS_VERSION: process.env.STREAM_REVIEW_ACCESS_VERSION
};

function restoreEnv(
  name: keyof typeof ORIGINAL_ENV,
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(() => {
  Object.entries(ORIGINAL_ENV).forEach(([name, value]) => {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  });
});

describe('seizeSettings auth rollout settings', () => {
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

describe('seizeSettings page access settings', () => {
  it('defaults the Stream review to hidden with version one', () => {
    delete process.env.STREAM_REVIEW_ACCESS_MODE;
    delete process.env.STREAM_REVIEW_ACCESS_VERSION;

    expect(seizeSettings().page_access).toEqual({
      stream_review: {
        mode: 'HIDDEN',
        version: 1
      }
    });
  });

  it.each(['HIDDEN', 'PASSWORD_PROTECTED', 'PUBLIC'])(
    'returns the configured %s Stream review mode',
    (mode) => {
      process.env.STREAM_REVIEW_ACCESS_MODE = mode;
      process.env.STREAM_REVIEW_ACCESS_VERSION = '7';

      expect(seizeSettings().page_access).toEqual({
        stream_review: {
          mode,
          version: 7
        }
      });
    }
  );

  it('normalizes the configured Stream review mode', () => {
    process.env.STREAM_REVIEW_ACCESS_MODE = ' password_protected ';

    expect(seizeSettings().page_access.stream_review.mode).toBe(
      'PASSWORD_PROTECTED'
    );
  });

  it('rejects an unsupported Stream review mode', () => {
    process.env.STREAM_REVIEW_ACCESS_MODE = 'private';

    expect(() => seizeSettings()).toThrow(
      'STREAM_REVIEW_ACCESS_MODE must be one of HIDDEN, PASSWORD_PROTECTED, PUBLIC'
    );
  });

  it.each(['0', '-1', '1.5', 'not-a-number'])(
    'rejects invalid Stream review access version %s',
    (version) => {
      process.env.STREAM_REVIEW_ACCESS_VERSION = version;

      expect(() => seizeSettings()).toThrow(
        'STREAM_REVIEW_ACCESS_VERSION must be a positive integer'
      );
    }
  );
});
