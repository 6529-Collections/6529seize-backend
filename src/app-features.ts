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
   * The interim record log: signed records batched into hash-chained
   * segment files whose heads are posted in the records wave.
   */
  public isSignedRecordLogEnabled(): boolean {
    return this.isFeatureEnabled('SIGNED_RECORD_LOG');
  }

  /**
   * Holdings re-key through the reconciliation queue: the delegations loop
   * queues the wallets it regroups instead of consolidating holdings itself,
   * and an hourly key sweep queues the wallets whose holdings don't match
   * their keys (a stale key, a missing one, or a wallet under two keys). An
   * operator's repair run of the sweep queues whatever this says, and so
   * does the identity mirror's own handler for the wallets it regroups.
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

  /**
   * Ethereum index fixes for a rebuild from empty: the NFT volume windows
   * count by block time instead of by when the transaction row was written.
   */
  public isEthIndexRebuildFixesEnabled(): boolean {
    return this.isFeatureEnabled('ETH_INDEX_REBUILD_FIXES');
  }

  public isProfileCmsWalletGalleryEnabled(): boolean {
    return (
      (process.env.FEATURE_PROFILE_CMS_WALLET_GALLERY ?? 'true') === 'true'
    );
  }
}

export const appFeatures = new AppFeatures();
