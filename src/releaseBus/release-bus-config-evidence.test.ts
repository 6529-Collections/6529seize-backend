import { getBaseCanaryEvidenceConfig } from '@/releaseBus/release-bus.config';

describe('base-canary evidence feature controls', () => {
  const names = [
    'RELEASE_BUS_BASE_EVIDENCE_REUSE',
    'RELEASE_BUS_BASE_EVIDENCE_REUSE_SHADOW',
    'RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS'
  ] as const;

  afterEach(() => names.forEach((name) => delete process.env[name]));

  it('defaults to fresh validation with a 24 hour bound', () => {
    expect(getBaseCanaryEvidenceConfig()).toEqual({
      reuse: false,
      shadow: false,
      maxAgeHours: 24
    });
  });

  it('enables lookup and reuse independently', () => {
    process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE = 'true';
    process.env.RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS = '12';
    expect(getBaseCanaryEvidenceConfig()).toEqual({
      reuse: true,
      shadow: false,
      maxAgeHours: 12
    });
  });

  it('fails closed when the maximum age is invalid', () => {
    process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE = 'true';
    process.env.RELEASE_BUS_BASE_EVIDENCE_REUSE_SHADOW = 'true';
    process.env.RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS = '999';
    expect(getBaseCanaryEvidenceConfig()).toEqual({
      reuse: false,
      shadow: false,
      maxAgeHours: 24
    });
  });
});

