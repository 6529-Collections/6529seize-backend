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
   * Holdings re-key through the reconciliation queue: the identity mirror's
   * membership hook queues the regrouped wallets, a sweep every 15 minutes
   * queues any it missed, and the delegations loop queues instead of
   * consolidating holdings itself.
   */
  public isHoldingsMembershipQueueEnabled(): boolean {
    return this.isFeatureEnabled('HOLDINGS_MEMBERSHIP_QUEUE');
  }

  /**
   * dbDumpsDaily writes manifest.json beside its CSVs (row counts, SHA-256
   * and each file's source) and skips delegations and consolidations while
   * the identity mirror isn't caught up.
   */
  public isDbDumpsManifestEnabled(): boolean {
    return this.isFeatureEnabled('DB_DUMPS_MANIFEST');
  }

  public isProfileCmsWalletGalleryEnabled(): boolean {
    return (
      (process.env.FEATURE_PROFILE_CMS_WALLET_GALLERY ?? 'true') === 'true'
    );
  }
}

export const appFeatures = new AppFeatures();
