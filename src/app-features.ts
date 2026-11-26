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
   * Waves, groups and decisions move to the 6529 chain: wave, group and
   * decision writes, entries, votes, wave REP and polls are refused here
   * while this is on (src/waves-freeze). Chat stays open.
   */
  public isWavesFrozen(): boolean {
    return this.isFeatureEnabled('WAVES_FROZEN');
  }

  /**
   * The Main Stage decision keeps running here through the waves freeze,
   * one more cycle: its entries, votes, pauses and results go on.
   */
  public isWavesFreezeKeepingMainStage(): boolean {
    return this.isFeatureEnabled('WAVES_FREEZE_KEEP_MAIN_STAGE');
  }

  /**
   * Waves have switched on on the 6529 chain: from then a wave stays on
   * 6529.io unless the chain holds it. WAVES_SWITCH_ON_AT sets the same at
   * a time (src/waves-freeze/waves-freeze.ts).
   */
  public isWavesOnChain(): boolean {
    return this.isFeatureEnabled('WAVES_ON_CHAIN');
  }

  /**
   * 6529.io shows polls made on the 6529 chain (the waves chain mirror
   * writes them into its poll tables). Until this is on, new polls in waves
   * that moved to the chain are refused from the switch-on
   * (src/waves-freeze/waves-chain-polls.ts).
   */
  public isWavesChainPollsLive(): boolean {
    return this.isFeatureEnabled('WAVES_CHAIN_POLLS');
  }

  /**
   * The delegations loop also mirrors the 6529 chain's identities into
   * 6529.io's identity tables (src/identity-chain-mirror).
   */
  public isIdentityChainMirrorEnabled(): boolean {
    return this.isFeatureEnabled('IDENTITY_CHAIN_MIRROR');
  }

  /**
   * Identities move to the 6529 chain: profiles, handles, statements, REP
   * and NIC are read-only here while this is on (src/identity-freeze).
   */
  public isIdentityFrozen(): boolean {
    return this.isFeatureEnabled('IDENTITY_FROZEN');
  }

  /** From switch-on the 6529 chain holds identities (src/identity-freeze). */
  public isIdentityOnChain(): boolean {
    return this.isFeatureEnabled('IDENTITY_ON_CHAIN');
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

  /**
   * The wave decision loop also keeps 6529.io's index of the 6529 chain's
   * waves, decisions and votes (src/waves-chain-index).
   */
  public isWavesChainIndexEnabled(): boolean {
    return this.isFeatureEnabled('WAVES_CHAIN_INDEX');
  }
}

export const appFeatures = new AppFeatures();
