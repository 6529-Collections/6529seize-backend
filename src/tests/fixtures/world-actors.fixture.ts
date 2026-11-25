// TEST ONLY. The identity world's actors as plain rows, for DB tests of
// seeds, which run with no chain and no mirror. A seed never writes these
// rows: it reads them by wallet (src/rebuild/run/probe-fixture.steps.ts).
// src/rebuild/world-actors-guard.test.ts fails on any file but a test that
// imports this module.
import { WorldActor } from '@/rebuild/manifests/probe-fixture';
import { writeWorldActorRows } from '@/rebuild/run/probe-fixture.steps';

/**
 * Writes the rows the identity world holds for these actors: profiles,
 * identities and address_consolidation_keys, with the world's ids, handles
 * and wallets; with `principals`, identity_chain_principals too (each the
 * chain's principal of an imported profile). The probes are written at
 * their fixture wallets, and subs-wide as one identity of 15 wallets. Call
 * it before running the seed.
 */
export async function writeWorldActorsForTests(
  actors: readonly WorldActor[],
  options: { principals?: boolean } = {}
): Promise<void> {
  await writeWorldActorRows(actors, options);
}
