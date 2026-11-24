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

  public isProfileCmsWalletGalleryEnabled(): boolean {
    return (
      (process.env.FEATURE_PROFILE_CMS_WALLET_GALLERY ?? 'true') === 'true'
    );
  }

  /**
   * The wave decision loop also keeps 6529.io's index of the 6529 chain's
   * waves, decisions and votes (src/waves-chain-index).
   */
  public isWavesChainIndexEnabled(): boolean {
    return this.isFeatureEnabled('WAVES_CHAIN_INDEX');
  }

  /**
   * The chain index queues a claim build for the rank-1 entry of a final
   * result of a Main Stage decision (MAIN_STAGE_DECISION_IDS).
   */
  public isWavesChainClaimBuildsEnabled(): boolean {
    return this.isFeatureEnabled('WAVES_CHAIN_CLAIM_BUILDS');
  }

  /**
   * After the chain index, the wave decision loop copies the chain's
   * decisions into 6529.io's competition tables (src/waves-chain-mirror).
   * It writes only with WAVES_CHAIN_MIRROR_WRITE=true; otherwise it reports
   * what it would write.
   */
  public isWavesChainMirrorEnabled(): boolean {
    return this.isFeatureEnabled('WAVES_CHAIN_MIRROR');
  }
}

export const appFeatures = new AppFeatures();
