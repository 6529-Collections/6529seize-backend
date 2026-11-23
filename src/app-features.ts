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

  /**
   * Replays subscription writes held back by the key-width guard
   * (subscription-key-width) once their key fits every subscription table,
   * in order per key. Rollback: unset it; the queue keeps the writes.
   */
  public isSubscriptionDeferredReplayEnabled(): boolean {
    return this.isFeatureEnabled('SUBSCRIPTION_DEFERRED_REPLAY');
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
   * Profile sites follow the person's ProfileDoc on the 6529 chain: the
   * primary pointer moves by PROFILE_REPLACE, and 6529.io's tables become an
   * index of it. Rollback: set FEATURE_PROFILE_CMS_CHAIN_POINTER=false.
   */
  public isProfileCmsChainPointerEnabled(): boolean {
    return this.isFeatureEnabled('PROFILE_CMS_CHAIN_POINTER');
  }

  /**
   * Profile site drafts and BYO agent grants, proposals and events are
   * appended to the interim record log's private chain as they are written,
   * so they can be rebuilt. Rollback: set FEATURE_PROFILE_CMS_PERSONAL_LOG=false.
   */
  public isProfileCmsPersonalLogEnabled(): boolean {
    return this.isFeatureEnabled('PROFILE_CMS_PERSONAL_LOG');
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
