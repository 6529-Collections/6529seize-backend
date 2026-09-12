import { shouldCaptureRawBody } from './raw-body-paths';

describe('shouldCaptureRawBody', () => {
  it('does not capture ordinary deploy routes', () => {
    expect(shouldCaptureRawBody('/deploy/ui/dispatch')).toBe(false);
  });

  it('preserves the existing signed webhook paths', () => {
    expect(shouldCaptureRawBody('/gh-hooks')).toBe(true);
    expect(shouldCaptureRawBody('/dev-alerts')).toBe(true);
    expect(shouldCaptureRawBody('/ci-pipeline-alerts/build')).toBe(true);
  });
});
