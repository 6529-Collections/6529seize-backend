export class AppFeatures {
  private isFeatureEnabled(feature: string): boolean {
    return process.env[`FEATURE_${feature}`] === 'true';
  }

  public isUploadCicRepSnaphotsToArweaveEnabled(): boolean {
    return this.isFeatureEnabled('UPLOAD_CIC_REP_SNAPSHOTS_TO_ARWEAVE');
  }

  public isDropOvervoteRevocationEnabled(): boolean {
    return this.isFeatureEnabled('DROP_OVERVOTE_REVOCATION');
  }

  public isDbMigrateDisabled(): boolean {
    return this.isFeatureEnabled('DB_MIGRATE_DISABLED');
  }

  public isExperimentalBulkRepEnabled(): boolean {
    return this.isFeatureEnabled('EXPERIMENTAL_BULK_REP');
  }

  public isXTdhEnabled(): boolean {
    return this.isFeatureEnabled('XTDH');
  }

  public isProfileCmsWalletGalleryEnabled(): boolean {
    return this.isFeatureEnabled('PROFILE_CMS_WALLET_GALLERY');
  }

  public isUnifiedCompetitionReadsEnabled(): boolean {
    return this.isFeatureEnabled('UNIFIED_COMPETITION_READS');
  }

  public isNativeCompetitionWritesEnabled(): boolean {
    return this.isFeatureEnabled('NATIVE_COMPETITION_WRITES');
  }

  public isNativeCompetitionExecutionEnabled(): boolean {
    return this.isFeatureEnabled('NATIVE_COMPETITION_EXECUTION');
  }

  public isNativeCompetitionHubCreationEnabled(): boolean {
    return this.isFeatureEnabled('NATIVE_COMPETITION_HUB_CREATION');
  }

  public isLegacyCompetitionShadowCompareEnabled(): boolean {
    return this.isFeatureEnabled('LEGACY_COMPETITION_SHADOW_COMPARE');
  }

  public getLegacyCompetitionShadowSampleRate(): number {
    const value = Number(
      process.env.COMPETITION_LEGACY_SHADOW_SAMPLE_RATE ?? '0'
    );
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
  }
}

export const appFeatures = new AppFeatures();
