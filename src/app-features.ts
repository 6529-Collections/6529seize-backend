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
   * The chain-day loop reads each TDH day from the 6529 chain, compares it
   * with the site's own computation and the live tables, and records the
   * result in tdh_chain_days. It writes no TDH table. Rollback: off.
   */
  public isTdhChainShadowEnabled(): boolean {
    return this.isFeatureEnabled('TDH_CHAIN_SHADOW');
  }

  /**
   * The TDH tables are written from the 6529 chain's days by the chain-day
   * loop; tdhLoop and the delegations loop no longer compute TDH. Rollback:
   * off, and tdhLoop computes the next day as before (TDH_RESET to do it at
   * once).
   */
  public isTdhFromChainEnabled(): boolean {
    return this.isFeatureEnabled('TDH_FROM_CHAIN');
  }

  /**
   * Identities move to the 6529 chain: profiles, handles, statements, REP
   * and NIC are read-only here while this is on (src/identity-freeze).
   */
  public isIdentityFrozen(): boolean {
    return this.isFeatureEnabled('IDENTITY_FROZEN');
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
}

export const appFeatures = new AppFeatures();
