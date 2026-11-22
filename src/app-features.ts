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

  /**
   * Large viewer group lists are read from viewer_group_set_members by their
   * hash instead of travelling in each statement (waves/viewer-group-sets).
   */
  public isViewerGroupSetTableEnabled(): boolean {
    return this.isFeatureEnabled('VIEWER_GROUP_SET_TABLE');
  }

  /**
   * Mint log, shadow: each write to the minting tables is also logged, while
   * the tables stay the source of truth. Rollback: set it to false.
   */
  public isMintLogShadowEnabled(): boolean {
    return this.isFeatureEnabled('MINT_LOG_SHADOW');
  }

  /**
   * Mint log, primary (the switch): admin writes need a signed `mint.admin`
   * record, and a write fails unless its log entry is queued. Rollback: set it
   * to false; the shadow log keeps running if MINT_LOG_SHADOW is on.
   */
  public isMintLogPrimaryEnabled(): boolean {
    return this.isFeatureEnabled('MINT_LOG_PRIMARY');
  }

  /**
   * After each logged write, replays the entry over the captured state in a
   * savepoint that is rolled back, and compares the rows. Rollback: false.
   */
  public isMintLogReplayCheckEnabled(): boolean {
    return this.isFeatureEnabled('MINT_LOG_REPLAY_CHECK');
  }

  /**
   * The interim record log: signed records batched into hash-chained
   * segment files whose heads are posted in the records wave.
   */
  public isSignedRecordLogEnabled(): boolean {
    return this.isFeatureEnabled('SIGNED_RECORD_LOG');
  }

  public isProfileCmsWalletGalleryEnabled(): boolean {
    return (
      (process.env.FEATURE_PROFILE_CMS_WALLET_GALLERY ?? 'true') === 'true'
    );
  }
}

export const appFeatures = new AppFeatures();
