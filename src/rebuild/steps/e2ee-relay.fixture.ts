// The rebuild check's fixed fixtures for encrypted messages: the seed writes
// them and the manifest's probes name them, so both must agree. Every value is
// obviously fake; the device keys come from fixed seeds.
import { e2eeKeyFromSeed } from '@/tests/fixtures/e2ee.fixture';

const seed = (byte: string) => `0x${byte.repeat(32)}`;

/**
 * Profiles, each with a fake wallet the probes sign in as. The wallets end
 * in e2ee0a-0c so no other area's seed picks the same one: a wallet another
 * seed already holds would sign the probes in as that seed's profile.
 */
export const E2EE_CHECK_PROFILES = {
  a: { profileId: 'rebuild-check-pa', wallet: `0x${'00'.repeat(17)}e2ee0a` },
  b: { profileId: 'rebuild-check-pb', wallet: `0x${'00'.repeat(17)}e2ee0b` },
  c: { profileId: 'rebuild-check-pc', wallet: `0x${'00'.repeat(17)}e2ee0c` }
} as const;

/** Device keys from fixed seeds: a's, b's and c's (c is revoked). */
export const E2EE_CHECK_KEYS = {
  a: e2eeKeyFromSeed(seed('d1')),
  b: e2eeKeyFromSeed(seed('d2')),
  c: e2eeKeyFromSeed(seed('d3')),
  commit0: e2eeKeyFromSeed(seed('e1')),
  commit1: e2eeKeyFromSeed(seed('e2')),
  commit2: e2eeKeyFromSeed(seed('e3'))
} as const;

/** The ids the seed gives its group, attachment, backup and report. */
export const E2EE_CHECK_IDS = {
  /** A public wave and a drop in it: reports are recorded only on those. */
  publicWave: 'rebuild-check-public-wave',
  publicDrop: 'rebuild-check-public-drop',
  group: `0x${'c1'.repeat(32)}`,
  blob: `0x${'b1'.repeat(16)}`,
  backup: `0x${'bb'.repeat(16)}`,
  messageReport: `0x${'e1'.repeat(16)}`
} as const;
