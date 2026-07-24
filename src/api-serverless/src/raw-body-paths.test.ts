import { shouldCaptureRawBody } from './raw-body-paths';

describe('shouldCaptureRawBody', () => {
  it('captures the fully mounted release-bus webhook path', () => {
    expect(shouldCaptureRawBody('/deploy/github/webhook')).toBe(true);
    expect(shouldCaptureRawBody('/deploy/github/webhook?delivery=1')).toBe(
      true
    );
  });

  it('does not capture neighboring deploy routes', () => {
    expect(shouldCaptureRawBody('/deploy/release-bus-v2/authorize')).toBe(
      false
    );
    expect(shouldCaptureRawBody('/deploy/github/webhook/extra')).toBe(false);
  });

  it('preserves the existing signed webhook paths', () => {
    expect(shouldCaptureRawBody('/gh-hooks')).toBe(true);
    expect(shouldCaptureRawBody('/dev-alerts')).toBe(true);
    expect(shouldCaptureRawBody('/ci-pipeline-alerts/build')).toBe(true);
  });
});
