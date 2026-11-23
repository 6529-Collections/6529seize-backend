/**
 * Fixed ids of rows the mint seed writes for the rebuild check, shared with
 * the mint manifest. No imports, so the manifest stays light to load.
 */

/** The seed's Main Stage wave (MAIN_STAGE_WAVE_ID in the mint flags). */
export const PROBE_MAIN_STAGE_WAVE = '00000000-0000-4000-8000-0000000000c1';

/** The Main Stage artwork drop the seed's collaboration belongs to. */
export const PROBE_COLLAB_DROP = '00000000-0000-4000-8000-0000000000c3';

/**
 * The wallets on each card's Phase 1 allowlist. No seed subscribes them, so
 * the subscriptions' split leaves the allowlist, and so its merkle root, the
 * same in every run.
 */
export const PROBE_PHASE_WALLETS = [
  '0x00000000000000000000000000000000000000b1',
  '0x00000000000000000000000000000000000000b2'
];
