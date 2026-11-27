import { computeAddress, keccak256, toUtf8Bytes } from 'ethers';

/**
 * The ids of the identity area's world for the rebuild check: six
 * identities on a devnet, four imported from 6529.io and two made on the
 * chain, and the wallets they hold, as the shared devnet capture's
 * identity world file (identity-world.json, beside its gateway recording)
 * gives them. The first two hold the probe fixture's wallets
 * (src/rebuild/manifests/probe-fixture.ts), so the probes that sign in find
 * a profile. The `site` ones carry the 6529.io rows the chain doesn't hold
 * (rebuild-world/site-rows.ts): only the site probes read them.
 *
 * Test wallets only. The low addresses are made up and never on the chain
 * but as the probe fixture's. The others are the devnet's: its harness
 * keys them by label, so they are the same on every capture (the
 * principals of the identities made on the chain are not, and nothing here
 * names them).
 */
const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

/**
 * A devnet test wallet, from its label: the devnet's harness takes the
 * Keccak-256 of "6529 devnet identity world <label>" as the wallet's
 * secp256k1 key (tools/devnet in the validator's repository), so the same
 * address follows from the label here. No person's wallet; it changes only
 * if the harness's derivation does (world-ids.test.ts pins the six to a
 * capture's identity world file).
 */
export function devnetWallet(label: string): string {
  return computeAddress(
    keccak256(toUtf8Bytes(`6529 devnet identity world ${label}`))
  ).toLowerCase();
}

/**
 * The pair's two wallets, the lower first: its anchor, as the harness
 * orders them.
 */
const [PAIR_LOWER, PAIR_HIGHER] = [
  devnetWallet('IPA'),
  devnetWallet('IPB')
].sort((a, b) => (a < b ? -1 : Number(a > b)));

export const IDENTITY_WORLD_WALLETS = {
  /** The probe fixture's first wallet: the probes' signed-in caller. */
  probe1: wallet(1),
  /** The probe fixture's second wallet. */
  probe2: wallet(2),
  /**
   * The two wallets of one imported identity, a consolidation: pairA the
   * lower, its anchor; a delegation (use case 997) makes pairB primary.
   */
  pairA: PAIR_LOWER,
  pairB: PAIR_HIGHER,
  /** The wallet that made an identity on the chain after the import. */
  founder: devnetWallet('IF'),
  /** A delegate that is no identity's wallet. */
  delegate: devnetWallet('ID'),
  /** A wallet with TDH and no profile: an identities row of 6529.io only. */
  tdhOnly: wallet(9),
  /**
   * A wallet with a 6529.io placeholder profile that made an identity on
   * the chain: the founder rule gives the identity the placeholder's id.
   */
  siteFounder: devnetWallet('ISF'),
  /** The wallet of an imported identity with TDH on 6529.io. */
  siteTdh: devnetWallet('IST'),
  /**
   * A wallet with a placeholder profile that no chain identity takes: the
   * rebuild restores it from the placeholders file, and the references
   * planted for it (rebuild-world/placeholder-references.ts) point at it.
   * The capture keeps it off the chain.
   */
  untaken: wallet(12),
  /** A wallet with an untaken placeholder profile and TDH on 6529.io. */
  untakenTdh: wallet(13)
};

/** The 6529.io profile ids the imported identities carry (their legacy ids). */
export const IDENTITY_WORLD_LEGACY_IDS = {
  probe1: '00000000-0000-4000-8000-000000000101',
  probe2: '00000000-0000-4000-8000-000000000102',
  pair: '00000000-0000-4000-8000-000000000103',
  siteTdh: '00000000-0000-4000-8000-00000000010b'
} as const;

/**
 * The placeholder profiles' ids, as the world's placeholders file
 * (rebuild-world/fixture-file.ts) holds them: the site founder's, which the
 * founder rule takes, and two no chain identity takes.
 */
export const IDENTITY_WORLD_PLACEHOLDER_IDS = {
  siteFounder: '00000000-0000-4000-8000-00000000010a',
  untaken: '00000000-0000-4000-8000-00000000010c',
  untakenTdh: '00000000-0000-4000-8000-00000000010d'
} as const;

/**
 * The id of the founder's wallet's address-only identities row from before
 * switch-on (a user group made with the wallet): the founder's chain
 * identity, on the same key, adopts it at the mirror's first run, and the
 * rebuild adopts it again from the switch-on record (switch-on-record.ts).
 * A random id in production; fixed here so the run can name it.
 */
export const IDENTITY_WORLD_ADOPTED_ID = '00000000-0000-4000-8000-00000000010e';

export const IDENTITY_WORLD_HANDLES = {
  probe1: 'rebuild_probe_1',
  probe2: 'rebuild_probe_2',
  pair: 'rebuild_pair',
  madeOnChain: 'rebuild_new',
  siteFounder: 'site_founder',
  siteTdh: 'site_tdh'
} as const;

/** The REP categories the world's ratings use. */
export const IDENTITY_WORLD_CATEGORIES = {
  builder: 'Probe Builder',
  tester: 'Probe Tester'
} as const;

/**
 * The waves world's people to whom the identity seed gives 6529.io TDH,
 * by profile id: profiles of the waves export (…01c0 to …01c7), which the
 * chain's identity import carries. Their votes and wave ratings read the
 * voter's credit from identities.tdh, which from switch-on is TDH alone.
 * From switch-on 6529.io's TDH mirrors the chain's day by day, so each
 * value is what 6529.io holds at the mark: that person's TDH on the chain
 * at the mark's TDH day, 20782 in the v9 and v10 captures (…01c7's after
 * its second wallet left). No site TDH above it is seeded. One entry each.
 */
export const WAVES_PEOPLE_TDH = [
  {
    profileId: '00000000-0000-4000-8000-0000000001c2',
    tdh: 26_709
  },
  {
    profileId: '00000000-0000-4000-8000-0000000001c3',
    tdh: 23_967
  },
  {
    profileId: '00000000-0000-4000-8000-0000000001c4',
    tdh: 33_566
  },
  {
    profileId: '00000000-0000-4000-8000-0000000001c7',
    tdh: 28_416
  }
] as const;
