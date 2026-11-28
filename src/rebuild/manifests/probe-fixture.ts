import { computeAddress, keccak256, toUtf8Bytes } from 'ethers';
import { MEMES_CONTRACT } from '@/constants';
import { ProbeCaller } from '@/rebuild/manifest.types';

/**
 * The values the probes ask about. A manifest's seed writes rows for them
 * (through the code's own write path, not straight into its INDEX tables);
 * until it does, those probes answer with no data and the report lists them
 * as unproven. Fake wallets only.
 */
export const PROBE_WALLETS = [
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002'
];

/** A one-wallet consolidation's key is its wallet. */
export const PROBE_CONSOLIDATION_KEYS = PROBE_WALLETS;

/** The signed-in caller of the probes that need one. */
export const PROBE_CALLER: ProbeCaller = { wallet: PROBE_WALLETS[0] };

/** Meme card ids the probes ask about. */
export const PROBE_MEME_IDS = ['1', '2'];

/**
 * A meme card that hasn't dropped: after the newest card the fixture mints
 * (the holdings seed mints cards 1 to 3), for routes about upcoming cards.
 */
export const PROBE_UPCOMING_MEME_ID = '4';

export const PROBE_MEMES_CONTRACT = MEMES_CONTRACT.toLowerCase();

/** A fixed window, so both passes ask for the same rows. */
export const PROBE_SINCE_MS = 1767225600000;
export const PROBE_TO_MS = 1767830400000;

/**
 * The identity world's actors: the identities other areas' seeds sign as or
 * name. They are chain identities on the test chain the gateway recordings
 * come from, so no seed writes a profile, identity, consolidation key or
 * principal for them; a seed reads them by wallet
 * (run/probe-fixture.steps.ts). Each wallet's key comes from its label, so
 * the same label gives the same wallet in every recording. Test keys only;
 * no person's wallet.
 */
export const WORLD_ACTOR_LABELS = [
  'records-service',
  'live-owner',
  'subs-wide-01',
  'subs-wide-02',
  'subs-wide-03',
  'subs-wide-04',
  'subs-wide-05',
  'subs-wide-06',
  'subs-wide-07',
  'subs-wide-08',
  'subs-wide-09',
  'subs-wide-10',
  'subs-wide-11',
  'subs-wide-12',
  'subs-wide-13',
  'subs-wide-14',
  'subs-wide-15',
  'dm-e2ee-a',
  'dm-e2ee-b',
  'dm-e2ee-c'
] as const;
export type WorldActorLabel = (typeof WORLD_ACTOR_LABELS)[number];

/** The subs wide identity's 15 wallets' labels; subs-wide-01 is the sender. */
export const SUBS_WIDE_LABELS: readonly WorldActorLabel[] =
  WORLD_ACTOR_LABELS.filter((label) => label.startsWith('subs-wide-'));

/**
 * The waves test people: devnet_p4 and devnet_p8 hold a second
 * wallet each (the `_b` labels), and there is no devnet_p5. Keyed with
 * their own prefix.
 */
export const WAVES_PERSON_LABELS = [
  'devnet_p0',
  'devnet_p1',
  'devnet_p2',
  'devnet_p3',
  'devnet_p4',
  'devnet_p4_b',
  'devnet_p6',
  'devnet_p7',
  'devnet_p8',
  'devnet_p8_b'
] as const;
export type WavesPersonLabel = (typeof WAVES_PERSON_LABELS)[number];

function labelKey(
  prefix: string,
  labels: readonly string[],
  label: string
): string {
  if (!labels.includes(label)) {
    throw new Error(
      `${label} is not one of the world's labels (${labels.join(', ')})`
    );
  }
  return keccak256(toUtf8Bytes(`${prefix} ${label}`));
}

/**
 * An actor's secp256k1 key, from its label: the Keccak-256 of
 * "6529 devnet identity world <label>", 0x and 64 hex digits.
 */
export function worldActorKey(label: WorldActorLabel): string {
  return labelKey('6529 devnet identity world', WORLD_ACTOR_LABELS, label);
}

/** The actor's wallet, lowercase 0x and 40 hex digits. */
export function worldActorWallet(label: WorldActorLabel): string {
  return computeAddress(worldActorKey(label)).toLowerCase();
}

/**
 * A waves test person's key, from its label: the Keccak-256 of
 * "6529 devnet waves person <label>".
 */
export function wavesPersonKey(label: WavesPersonLabel): string {
  return labelKey('6529 devnet waves person', WAVES_PERSON_LABELS, label);
}

/** The waves test person's wallet, lowercase 0x and 40 hex digits. */
export function wavesPersonWallet(label: WavesPersonLabel): string {
  return computeAddress(wavesPersonKey(label)).toLowerCase();
}

/** One identity of the world: subs-wide holds its 15 labels' wallets. */
export type WorldActor =
  | 'probe-1'
  | 'probe-2'
  | 'records-service'
  | 'live-owner'
  | 'subs-wide'
  | 'dm-e2ee-a'
  | 'dm-e2ee-b'
  | 'dm-e2ee-c';

/**
 * Each actor's world-form profile (legacy) id, handle and wallets. The
 * probes keep the fixture's wallets.
 */
const WORLD_ACTORS: Record<
  WorldActor,
  { profileId: string; handle: string; wallets: () => string[] }
> = {
  'probe-1': {
    profileId: '00000000-0000-4000-8000-000000000101',
    handle: 'rebuild_probe_1',
    wallets: () => [PROBE_WALLETS[0]]
  },
  'probe-2': {
    profileId: '00000000-0000-4000-8000-000000000102',
    handle: 'rebuild_probe_2',
    wallets: () => [PROBE_WALLETS[1]]
  },
  'records-service': {
    profileId: '00000000-0000-4000-8000-0000000001a1',
    handle: 'rebuild_records',
    wallets: () => [worldActorWallet('records-service')]
  },
  'live-owner': {
    profileId: '00000000-0000-4000-8000-0000000000b1',
    handle: 'rebuild_live',
    wallets: () => [worldActorWallet('live-owner')]
  },
  'subs-wide': {
    profileId: '00000000-0000-4000-8000-0000000001d0',
    handle: 'rebuild_wide',
    wallets: () => SUBS_WIDE_LABELS.map((label) => worldActorWallet(label))
  },
  'dm-e2ee-a': {
    profileId: '00000000-0000-4000-8000-0000000001e1',
    handle: 'rebuild_dm_a',
    wallets: () => [worldActorWallet('dm-e2ee-a')]
  },
  'dm-e2ee-b': {
    profileId: '00000000-0000-4000-8000-0000000001e2',
    handle: 'rebuild_dm_b',
    wallets: () => [worldActorWallet('dm-e2ee-b')]
  },
  'dm-e2ee-c': {
    profileId: '00000000-0000-4000-8000-0000000001e3',
    handle: 'rebuild_dm_c',
    wallets: () => [worldActorWallet('dm-e2ee-c')]
  }
};

export const ALL_WORLD_ACTORS: readonly WorldActor[] = Object.keys(
  WORLD_ACTORS
) as WorldActor[];

/**
 * An actor's fixed profile (legacy) id, for a probe whose path names it
 * (a probe's `each` and `params` hold literals). Manifests and tests only:
 * a seed takes a probe's id from probeProfileId, which identity.actors-check
 * backs, and any other actor's by wallet (profileIdByWallet); a unit test
 * fails on any other file that names this function.
 */
export function worldActorProfileId(actor: WorldActor): string {
  return WORLD_ACTORS[actor].profileId;
}

/**
 * An actor's identity as the identity import writes it: its profile id, handle,
 * wallets in order and primary wallet, the lowest (the import sorts an
 * identity's wallets and takes the first as its primary address). What the
 * fallback world's seed and the tests' stand-in write. The same guard as
 * worldActorProfileId applies.
 */
export function worldActorIdentity(actor: WorldActor): {
  profileId: string;
  handle: string;
  wallets: string[];
  primary: string;
} {
  const { profileId, handle, wallets } = WORLD_ACTORS[actor];
  const sorted = wallets().sort(compareCodeUnits);
  return { profileId, handle, wallets: sorted, primary: sorted[0] };
}

/** UTF-16 code unit order, the same on every machine. */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
