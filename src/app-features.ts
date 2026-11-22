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
   * the tables stay the source of truth. A logging failure is alerted and the
   * write goes ahead. Turning it off and on again leaves a gap that needs a
   * new genesis. Rollback: set it to false.
   */
  public isMintLogShadowEnabled(): boolean {
    return this.isFeatureEnabled('MINT_LOG_SHADOW');
  }

  /**
   * Mint log, primary (the switch): admin writes need a signed `mint.admin`
   * record (collaboration invites and replies a `mint.user` record once
   * MINT_LOG_COLLAB_RECORDS is on), and a write fails unless its log entry
   * is queued. Not usable yet: until the principal bindings and the site's
   * principal source are bound, it refuses every admin minting write from
   * the site (400 INVALID_SIGNED_RECORD, since the site sends no record yet;
   * 503 for a record that cannot be checked). NextGen uploads and service
   * writes are not refused. The API logs the state at start
   * ([MINT_LOG] ... [RECORD VERIFIER ...]).
   * Rollback: set it to false; the shadow log keeps running if
   * MINT_LOG_SHADOW is on.
   */
  public isMintLogPrimaryEnabled(): boolean {
    return this.isFeatureEnabled('MINT_LOG_PRIMARY');
  }

  /**
   * In primary mode, collaboration invites and replies through the API need
   * the user's signed `mint.user` record too. Off (the default): they keep
   * shadow rules, and a missing or bad record is logged, never refused, so
   * artists without a device grant can still invite and reply. Turn it on
   * once most artists have enrolled; the team decides when. Rollback: set it
   * to false.
   */
  public isMintLogCollabRecordsRequired(): boolean {
    return this.isFeatureEnabled('MINT_LOG_COLLAB_RECORDS');
  }

  /**
   * After each logged write, replays the entry over the captured state in a
   * savepoint that is rolled back, and compares the rows. Rollback: false.
   */
  public isMintLogReplayCheckEnabled(): boolean {
    return this.isFeatureEnabled('MINT_LOG_REPLAY_CHECK');
  }

  /**
   * NextGen allowlist uploads must sign the CSV's sha256 with the rest of the
   * payload. Off: a signed hash is checked when present. Rollback: false.
   */
  public isNextgenAllowlistSignedFileRequired(): boolean {
    return this.isFeatureEnabled('NEXTGEN_ALLOWLIST_SIGNED_FILE');
  }

  /**
   * The team loop also loads the pre-vote artist badges from
   * prevote-artists.csv beside team.csv. Rollback: set it to false; the
   * table keeps its rows.
   */
  public isMintHandListsEnabled(): boolean {
    return this.isFeatureEnabled('MINT_HAND_LISTS');
  }

  /**
   * The rememes file loop removes only rows that came from rememes.csv, so
   * rememes added on the site stay. Off: it removes every row missing from
   * the file, as before. Rollback: set it to false.
   */
  public isRememesKeepAddedEnabled(): boolean {
    return this.isFeatureEnabled('REMEMES_KEEP_ADDED');
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
