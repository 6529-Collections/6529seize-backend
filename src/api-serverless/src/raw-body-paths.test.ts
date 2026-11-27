import { shouldCaptureRawBody } from './raw-body-paths';

describe('shouldCaptureRawBody', () => {
  it('does not capture ordinary API requests', () => {
    expect(shouldCaptureRawBody('/api/drops')).toBe(false);
  });

  it('preserves the existing signed webhook paths', () => {
    expect(shouldCaptureRawBody('/gh-hooks')).toBe(true);
    expect(shouldCaptureRawBody('/dev-alerts')).toBe(true);
    expect(shouldCaptureRawBody('/ci-pipeline-alerts/build')).toBe(true);
  });
});
