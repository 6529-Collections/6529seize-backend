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

  /**
   * The subscriptions re-key fallback: every fifth minute the top-up loop
   * re-keys legacy subscription keys whose wallets the identity mirror now
   * groups otherwise (subscription-rekey-fallback). Turn it on if nothing
   * else re-keys subscriptions after the mirror's first run. Rollback: unset
   * it; keys stay as they are until the next re-key.
   */
  public isSubscriptionRekeyOnMirrorEnabled(): boolean {
    return this.isFeatureEnabled('SUBSCRIPTIONS_REKEY_ON_MIRROR');
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
   * poller, over the day tdhLoop's 00:01 run still computes as the fallback;
   * the delegations loop's within-day TDH rerun stops. Rollback: off, and
   * nothing replaces the site's own days; invoke tdhLoop once to recompute
   * today's day at once (its config sets TDH_RESET, so it does).
   */
  public isTdhFromChainEnabled(): boolean {
    return this.isFeatureEnabled('TDH_FROM_CHAIN');
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

  /**
   * The wave decision loop also sends a SETTLEMENT_REQUEST for each decision
   * result due on the 6529 chain (src/waves-settlement).
   */
  public isWavesSettlementSenderEnabled(): boolean {
    return this.isFeatureEnabled('WAVES_SETTLEMENT_SENDER');
  }
}

export const appFeatures = new AppFeatures();
