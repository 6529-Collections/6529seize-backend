// The world's actors for seeds: their wallets and keys by label, and their
// profile ids and principals read by wallet (the probes' ids are fixed, and
// identity.actors-check proves the world holds them). From switch-on the
// chain is the only source of identities, so no seed writes a profile,
// identity, consolidation key or principal for an actor; it reads them
// here, after identity.probe-profiles.
//
// That seed (seedProbeIdentities) is the identity area's on the fallback
// world, where the gateway serves no identity import. It writes every
// actor's rows with plain SQL, not through the identity code's write path,
// since without an import there is nothing for the mirror to write from;
// they carry the identity world's ids, handles, wallets and principals, so
// the lookups answer as they do on the identity world, where the chain
// mirror writes them. Their other columns (TDH, REP, NIC, classification)
// are zero or PSEUDONYM, not the world's. On the identity world the seed
// runs the mirror instead, and this fallback goes once every run replays a
// recording with the identity import.
import { keccak256 } from 'ethers';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
  PROFILES_TABLE
} from '@/constants';
import { consolidationTools } from '@/consolidation-tools';
import {
  ALL_WORLD_ACTORS,
  PROBE_SINCE_MS,
  PROBE_WALLETS,
  WAVES_PERSON_LABELS,
  WORLD_ACTOR_LABELS,
  WorldActor,
  wavesPersonWallet,
  worldActorIdentity,
  worldActorWallet
} from '@/rebuild/manifests/probe-fixture';
import { dbSupplier } from '@/sql-executor';

export {
  SUBS_WIDE_LABELS,
  WAVES_PERSON_LABELS,
  WORLD_ACTOR_LABELS,
  wavesPersonKey,
  wavesPersonWallet,
  worldActorKey,
  worldActorWallet
} from '@/rebuild/manifests/probe-fixture';
export type {
  WavesPersonLabel,
  WorldActorLabel
} from '@/rebuild/manifests/probe-fixture';

/** A wallet's label and where it can be found, for messages. */
function labelOf(wallet: string): string {
  const lower = wallet.toLowerCase();
  const probe = PROBE_WALLETS.indexOf(lower);
  const actor =
    probe >= 0
      ? `probe-${probe + 1}`
      : WORLD_ACTOR_LABELS.find((label) => worldActorWallet(label) === lower);
  if (actor) {
    return ` (${actor}). A seed reads the world's actors after identity.probe-profiles; on the identity world the gateway recording must carry the actor`;
  }
  const person = WAVES_PERSON_LABELS.find(
    (label) => wavesPersonWallet(label) === lower
  );
  if (person) {
    return ` (${person}). The waves people come only from a recording's identity import, so they are found only on the identity world, from a recording keyed by label`;
  }
  return '';
}

/**
 * The profile id of the identity holding the wallet:
 * address_consolidation_keys -> identities.profile_id. Throws, naming the
 * wallet and its label, when no identity with a profile holds it.
 */
export async function profileIdByWallet(wallet: string): Promise<string> {
  const profileId = await heldBy(wallet);
  if (!profileId) {
    throw new Error(
      `No identity with a profile holds wallet ${wallet.toLowerCase()}${labelOf(wallet)}`
    );
  }
  return profileId;
}

/** The profile id of the identity holding the wallet, or null. */
async function heldBy(wallet: string): Promise<string | null> {
  const row = await dbSupplier().oneOrNull<{ profile_id: string | null }>(
    `select i.profile_id
       from ${ADDRESS_CONSOLIDATION_KEY} a
       join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key
      where a.address = :wallet`,
    { wallet: wallet.toLowerCase() }
  );
  return row?.profile_id ?? null;
}

/**
 * The chain principal of a profile: identity_chain_principals.principal_id.
 * Throws when the profile has none.
 */
export async function principalByProfileId(profileId: string): Promise<string> {
  const row = await dbSupplier().oneOrNull<{ principal_id: string }>(
    `select principal_id from ${IDENTITY_CHAIN_PRINCIPALS_TABLE}
      where profile_id = :profileId`,
    { profileId }
  );
  if (!row) {
    throw new Error(`Profile ${profileId} has no chain principal`);
  }
  return row.principal_id;
}

/** The actors that probeProfileId names without reading the database. */
const PROBE_ACTORS: readonly WorldActor[] = ['probe-1', 'probe-2'];

/**
 * The n-th probe wallet's profile id, from 1: the world's fixed id for
 * probe-n. identity.actors-check proves the world holds that profile
 * under the probe's wallet before any other seed runs.
 */
export function probeProfileId(n: number): string {
  const actor = PROBE_ACTORS[n - 1];
  if (!Number.isInteger(n) || !PROBE_WALLETS[n - 1] || !actor) {
    throw new Error(
      `There is no probe wallet ${n}: they run from 1 to ${PROBE_WALLETS.length}`
    );
  }
  return worldActorIdentity(actor).profileId;
}

/**
 * identity.actors-check, right after identity.probe-profiles on every
 * world: each actor the world holds has the world's fixed profile id under
 * every one of its wallets, and the chain's principal of that id. Any
 * difference fails, naming the actor, the wallet or profile, and both
 * ids. An actor no identity holds fails only if probeProfileId names it;
 * any other is noted, since a seed that reads it by wallet fails there.
 * Returns the notes.
 */
export async function checkWorldActors(): Promise<string[]> {
  const notes: string[] = [];
  for (const actor of ALL_WORLD_ACTORS) {
    const { profileId, wallets } = worldActorIdentity(actor);
    const held = await Promise.all(wallets.map((wallet) => heldBy(wallet)));
    if (held.every((id) => id === null)) {
      if (PROBE_ACTORS.includes(actor)) {
        throw new Error(
          `${actor}: no identity holds wallet ${wallets[0]}, but probeProfileId gives the world's id ${profileId} for it`
        );
      }
      notes.push(
        `${actor} is not in this world; a seed that reads it by wallet fails there`
      );
      continue;
    }
    for (let i = 0; i < wallets.length; i += 1) {
      if (held[i] !== profileId) {
        throw new Error(
          `${actor}: wallet ${wallets[i]} is held by ${held[i] === null ? 'no profile' : `profile ${held[i]}`}, not the world's ${profileId}`
        );
      }
    }
    const want = importedPrincipalId(profileId);
    const row = await dbSupplier().oneOrNull<{ principal_id: string }>(
      `select principal_id from ${IDENTITY_CHAIN_PRINCIPALS_TABLE}
        where profile_id = :profileId`,
      { profileId }
    );
    if (row?.principal_id !== want) {
      throw new Error(
        `${actor}: profile ${profileId}'s principal is ${row ? row.principal_id : 'missing'}, not the chain's ${want}`
      );
    }
  }
  return notes;
}

/** The step: checkWorldActors, with its notes in the step's log. */
export async function checkWorldActorsStep(): Promise<void> {
  for (const note of await checkWorldActors()) {
    process.stdout.write(`${note}\n`);
  }
}

const DERIVED_ID_TAG = keccak256(Buffer.from('6529.DerivedId.v1', 'ascii'));
/** The chain's id kind of a principal. */
const PRINCIPAL_KIND = 0x0101;

/**
 * The chain's principal of an imported profile (its holder id): DerivedId
 * of the legacy id's 16 bytes padded to 32, index 0, kind PRINCIPAL, so
 * Keccak-256 of TAG("6529.DerivedId.v1"), that word, uint 0 and uint
 * 0x0101.
 */
export function importedPrincipalId(profileId: string): string {
  const legacy = profileId.toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(legacy)) {
    throw new Error(`${profileId} is not a UUID`);
  }
  const word = (n: number) => n.toString(16).padStart(64, '0');
  return keccak256(
    `${DERIVED_ID_TAG}${legacy}${'0'.repeat(32)}${word(0)}${word(PRINCIPAL_KIND)}`
  );
}

/**
 * Writes the identity world's rows for these actors, as plain rows:
 * profiles, identities and address_consolidation_keys, and with
 * `principals` identity_chain_principals. A row already there is kept, so
 * a second run changes nothing; then the actor is read back (its profile by
 * handle, each wallet's profile, and its principal), and a row
 * another seed wrote in its place fails here rather than in the seed that
 * reads it. The fallback world's seed and the
 * tests' stand-in (src/tests/fixtures/world-actors.fixture.ts) only; a unit
 * test fails on any other file that names it.
 */
export async function writeWorldActorRows(
  actors: readonly WorldActor[],
  options: { principals?: boolean } = {}
): Promise<void> {
  // The world's clock for rows it doesn't date: the probes' window start.
  const created = new Date(PROBE_SINCE_MS);
  for (const actor of actors) {
    const { profileId, handle, wallets, primary } = worldActorIdentity(actor);
    const key = consolidationTools.buildConsolidationKey(wallets);
    const params = {
      profileId,
      handle,
      normalised: handle.toLowerCase(),
      primary,
      key,
      created,
      createdMs: PROBE_SINCE_MS
    };
    await dbSupplier().execute(
      `insert ignore into ${PROFILES_TABLE}
         (external_id, handle, normalised_handle, primary_wallet, created_at,
          created_by_wallet, classification)
       values (:profileId, :handle, :normalised, :primary, :created,
          :primary, 'PSEUDONYM')`,
      params
    );
    await dbSupplier().execute(
      `insert ignore into ${IDENTITIES_TABLE}
         (consolidation_key, profile_id, primary_address, handle,
          normalised_handle, tdh, rep, cic, level_raw, classification,
          xtdh, produced_xtdh, granted_xtdh, xtdh_rate, basetdh_rate)
       values (:key, :profileId, :primary, :handle, :normalised,
          0, 0, 0, 0, 'PSEUDONYM', 0, 0, 0, 0, 0)`,
      params
    );
    for (const wallet of wallets) {
      await dbSupplier().execute(
        `insert ignore into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
         values (:wallet, :key)`,
        { wallet, key }
      );
    }
    if (options.principals) {
      await dbSupplier().execute(
        `insert ignore into ${IDENTITY_CHAIN_PRINCIPALS_TABLE}
           (principal_id, profile_id, origin, created_at)
         values (:principal, :profileId, 'LEGACY', :createdMs)`,
        { ...params, principal: importedPrincipalId(profileId) }
      );
    }
    await readBack(actor, profileId, handle, wallets, options.principals);
  }
}

/** Fails when a row another seed wrote stands where the actor's should. */
async function readBack(
  actor: WorldActor,
  profileId: string,
  handle: string,
  wallets: readonly string[],
  principals = false
): Promise<void> {
  // Each check says what it found; the cause is the same for all of them.
  const fail = (found: string): never => {
    throw new Error(`${actor}: ${found}; another seed wrote it`);
  };
  const profile = await dbSupplier().oneOrNull<{ external_id: string }>(
    `select external_id from ${PROFILES_TABLE}
      where normalised_handle = :normalised`,
    { normalised: handle.toLowerCase() }
  );
  if (profile?.external_id !== profileId) {
    fail(
      `handle ${handle} belongs to ${profile ? `profile ${profile.external_id}` : 'no profile'}, not the world's ${profileId}`
    );
  }
  for (const wallet of wallets) {
    const held = await heldBy(wallet);
    if (held !== profileId) {
      fail(
        `wallet ${wallet} is held by ${held === null ? 'no profile' : `profile ${held}`}, not the world's ${profileId}`
      );
    }
  }
  if (principals) {
    const want = importedPrincipalId(profileId);
    const principal = await dbSupplier().oneOrNull<{ principal_id: string }>(
      `select principal_id from ${IDENTITY_CHAIN_PRINCIPALS_TABLE}
        where profile_id = :profileId`,
      { profileId }
    );
    if (principal?.principal_id === want) return;
    if (principal) {
      fail(
        `profile ${profileId}'s principal is ${principal.principal_id}, not the chain's ${want}`
      );
    }
    // No row for the profile: another profile may hold the chain's principal.
    const holder = await dbSupplier().oneOrNull<{ profile_id: string }>(
      `select profile_id from ${IDENTITY_CHAIN_PRINCIPALS_TABLE}
        where principal_id = :want`,
      { want }
    );
    fail(
      holder
        ? `the chain's principal ${want} is profile ${holder.profile_id}'s, not ${profileId}'s`
        : `profile ${profileId} has no principal`
    );
  }
}

/**
 * identity.probe-profiles on the fallback world: every actor's rows, with
 * their principals.
 */
export async function seedProbeIdentities(): Promise<void> {
  await writeWorldActorRows(ALL_WORLD_ACTORS, { principals: true });
}
