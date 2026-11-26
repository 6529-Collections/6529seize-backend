// The identity area's seed for the probe fixture (identity.probe-profiles):
// a profile for each fixture wallet, so probes that sign in (as
// PROBE_CALLER) reach their handler, and no other area's seed writes
// identity rows. It writes the rows with plain SQL, not through the
// identity code's write path, because identity has no rebuilder yet and
// its tables are kept through the drop. When identity's rebuilder lands,
// the fixture profiles move into the chain gateway recording it rebuilds
// from, and this seed goes.
import { ADDRESS_CONSOLIDATION_KEY, IDENTITIES_TABLE } from '@/constants';
import { PROBE_WALLETS } from '@/rebuild/manifests/probe-fixture';
import { dbSupplier } from '@/sql-executor';

/** The profile id and handle of the n-th fixture wallet, from 1. */
export function probeProfileId(n: number): string {
  return `rebuild-probe-${n}`;
}

export async function seedProbeIdentities(): Promise<void> {
  for (let index = 0; index < PROBE_WALLETS.length; index++) {
    const wallet = PROBE_WALLETS[index];
    const profileId = probeProfileId(index + 1);
    await dbSupplier().execute(
      `insert ignore into ${IDENTITIES_TABLE}
         (consolidation_key, profile_id, primary_address, handle,
          normalised_handle, tdh, rep, cic, level_raw, classification,
          xtdh, produced_xtdh, granted_xtdh, xtdh_rate, basetdh_rate)
       values (:wallet, :profileId, :wallet, :profileId, :profileId,
          0, 0, 0, 0, 'PSEUDONYM', 0, 0, 0, 0, 0)`,
      { wallet, profileId }
    );
    await dbSupplier().execute(
      `insert ignore into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
       values (:wallet, :wallet)`,
      { wallet }
    );
  }
}
