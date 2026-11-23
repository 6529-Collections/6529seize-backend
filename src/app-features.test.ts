import { appFeatures } from '@/app-features';

describe('profile CMS wallet gallery feature flag', () => {
  const original = process.env.FEATURE_PROFILE_CMS_WALLET_GALLERY;
  afterEach(() => {
    if (original === undefined)
      delete process.env.FEATURE_PROFILE_CMS_WALLET_GALLERY;
    else process.env.FEATURE_PROFILE_CMS_WALLET_GALLERY = original;
  });

  it.each([
    [undefined, true],
    ['true', true],
    ['false', false],
    ['TRUE', false],
    ['', false],
    ['unknown', false]
  ])(
    'evaluates %s as %s while preserving explicit disable',
    (value, enabled) => {
      if (value === undefined)
        delete process.env.FEATURE_PROFILE_CMS_WALLET_GALLERY;
      else process.env.FEATURE_PROFILE_CMS_WALLET_GALLERY = String(value);
      expect(appFeatures.isProfileCmsWalletGalleryEnabled()).toBe(enabled);
    }
  );
});

describe('help bot credits feature flag', () => {
  const original = process.env.FEATURE_HELP_BOT_CREDITS;
  afterEach(() => {
    if (original === undefined) delete process.env.FEATURE_HELP_BOT_CREDITS;
    else process.env.FEATURE_HELP_BOT_CREDITS = original;
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['TRUE', false],
    ['true', true]
  ])('evaluates %s as %s: off unless exactly true', (value, enabled) => {
    if (value === undefined) delete process.env.FEATURE_HELP_BOT_CREDITS;
    else process.env.FEATURE_HELP_BOT_CREDITS = String(value);
    expect(appFeatures.isHelpBotCreditsEnabled()).toBe(enabled);
  });
});
