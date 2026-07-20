import { appFeatures } from '@/app-features';

describe('competition feature flags', () => {
  const names = [
    'FEATURE_UNIFIED_COMPETITION_READS',
    'FEATURE_NATIVE_COMPETITION_WRITES',
    'FEATURE_NATIVE_COMPETITION_EXECUTION',
    'FEATURE_NATIVE_COMPETITION_HUB_CREATION',
    'FEATURE_LEGACY_COMPETITION_SHADOW_COMPARE'
  ] as const;

  afterEach(() => {
    for (const name of names) delete process.env[name];
    delete process.env.COMPETITION_LEGACY_SHADOW_SAMPLE_RATE;
  });

  it('keeps every competition capability off by default', () => {
    expect(appFeatures.isUnifiedCompetitionReadsEnabled()).toBe(false);
    expect(appFeatures.isNativeCompetitionWritesEnabled()).toBe(false);
    expect(appFeatures.isNativeCompetitionExecutionEnabled()).toBe(false);
    expect(appFeatures.isNativeCompetitionHubCreationEnabled()).toBe(false);
    expect(appFeatures.isLegacyCompetitionShadowCompareEnabled()).toBe(false);
  });

  it('requires the exact true value', () => {
    process.env.FEATURE_UNIFIED_COMPETITION_READS = 'TRUE';
    expect(appFeatures.isUnifiedCompetitionReadsEnabled()).toBe(false);
    process.env.FEATURE_UNIFIED_COMPETITION_READS = 'true';
    expect(appFeatures.isUnifiedCompetitionReadsEnabled()).toBe(true);
  });

  it('keeps shadow sampling safe for missing or invalid rates', () => {
    expect(appFeatures.getLegacyCompetitionShadowSampleRate()).toBe(0);
    process.env.COMPETITION_LEGACY_SHADOW_SAMPLE_RATE = 'not-a-rate';
    expect(appFeatures.getLegacyCompetitionShadowSampleRate()).toBe(0);
    process.env.COMPETITION_LEGACY_SHADOW_SAMPLE_RATE = 'Infinity';
    expect(appFeatures.getLegacyCompetitionShadowSampleRate()).toBe(0);
    process.env.COMPETITION_LEGACY_SHADOW_SAMPLE_RATE = '-0.1';
    expect(appFeatures.getLegacyCompetitionShadowSampleRate()).toBe(0);
    process.env.COMPETITION_LEGACY_SHADOW_SAMPLE_RATE = '1.1';
    expect(appFeatures.getLegacyCompetitionShadowSampleRate()).toBe(0);
    process.env.COMPETITION_LEGACY_SHADOW_SAMPLE_RATE = '0.125';
    expect(appFeatures.getLegacyCompetitionShadowSampleRate()).toBe(0.125);
  });
});
