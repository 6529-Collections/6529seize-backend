import { parseReleaseValidationMessage } from './index';

const message = (overrides: Record<string, unknown> = {}) => ({
  message_type: 'release_validation',
  repo: '6529-Collections/6529seize-frontend',
  workflow: 'Production E2E',
  run_id: '789',
  run_url: 'https://github.com/example/actions/runs/789',
  sha: 'a'.repeat(40),
  release_group_id: 'frontend-release',
  triggered_by_github_login: 'prxt6529',
  status: 'success',
  ...overrides
});

describe('parseReleaseValidationMessage', () => {
  it('parses string and already-parsed queue envelopes', () => {
    expect(
      parseReleaseValidationMessage(JSON.stringify(message())).run_id
    ).toBe('789');
    expect(parseReleaseValidationMessage(message()).run_id).toBe('789');
  });

  it('preserves manual validation mode', () => {
    expect(
      parseReleaseValidationMessage(message({ validation_mode: 'manual' }))
        .validation_mode
    ).toBe('manual');
  });

  it.each([
    [
      { repo: '6529-Collections/6529seize-backend' },
      'repo must identify 6529seize-frontend'
    ],
    [{ sha: 'ABC123' }, 'sha must be a lowercase 40-character commit SHA'],
    [{ pull_request_number: 1923 }, 'pull_request_number must be null'],
    [{ status: 'pending' }, 'status must be success or failure'],
    [
      { triggered_by_github_login: 'not a login' },
      'triggered_by_github_login must be a valid GitHub login'
    ]
  ])('rejects invalid validation identity %p', (overrides, expected) => {
    expect(() => parseReleaseValidationMessage(message(overrides))).toThrow(
      expected
    );
  });
});
