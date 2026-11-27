import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE
} from '@/constants';
import { IdentityEntity } from '@/entities/IIdentity';
import { ConsolidatedTDH } from '@/entities/ITDH';
import { identitiesService } from '@/api/identities/identities.service';
import { identitiesDb } from '@/identities/identities.db';
import { identityConsolidationEffects } from '@/identity';
import { identityMetricsSync } from '@/identity-metrics-sync';
import { dbSupplier } from '@/sql-executor';
import { PlaceholderAtFreezeLine } from '../placeholders-at-freeze.format';
import {
  consolidatedTdhRow,
  consolidatedTdhRowOf
} from './consolidated-tdh-row';
import {
  IDENTITY_WORLD_ADOPTED_ID,
  IDENTITY_WORLD_WALLETS,
  WAVES_PEOPLE_TDH
} from './world-ids';

/**
 * The 6529.io rows the identity seed writes around the mirror's run, which
 * the chain doesn't hold, each on an identity only its site probe reads
 * (world-ids.ts), and each through the code that writes it in production:
 * - before switch-on, the placeholder profiles of the placeholders file
 *   (IdentitiesService.bulkCreateIdentities, on an identities row with
 *   the file's profile id): the site founder's, which the founder rule
 *   takes, and two no chain identity takes, which the rebuild restores
 *   from the file; a TDH-only identity (step B of the identities sync
 *   after TDH, from its consolidated TDH row); and an address-only
 *   identity on the founder's wallet (a user group made with it,
 *   IdentitiesDb.insertIdentitiesOnAddressesOnly), which the founder's
 *   chain identity adopts at switch-on;
 * - after switch-on, TDH on an imported identity and on an untaken
 *   placeholder (IdentityMetricsSync's scoped sync, from their
 *   consolidated TDH rows), which from switch-on writes tdh and
 *   basetdh_rate only; and, with the waves world, TDH on its people who
 *   vote and rate (writeWavesPeopleTdh).
 *
 * The consolidated TDH rows (tdh_consolidation) are the TDH area's table.
 * The identity seed writes them for its own wallets. Once the TDH area's
 * seed writes the shared scenario's TDH rows, it must provide these too,
 * for these wallets and these values, and this seed stops writing them.
 */

const W = IDENTITY_WORLD_WALLETS;

/** The TDH the TDH loop computed for the site wallets. */
export const SITE_TDH = {
  tdhOnly: 400,
  siteTdh: 1_000,
  untakenTdh: 700
} as const;

/** The two settings that say 6529.io is on the chain (identity-freeze.ts). */
const SWITCH_ON_FLAG = 'FEATURE_IDENTITY_ON_CHAIN';
const SWITCH_ON_AT = 'IDENTITY_SWITCH_ON_AT';

/**
 * Runs `work` as 6529.io before switch-on: the run is on the chain (the
 * flag on, or the world's switch-on time set and past), and the writes of
 * this step that come before it (a placeholder profile, step B) run only
 * before. For the block the flag is off and the time unset; both come back
 * after it, an unset one unset. Only this step's own process sees it, so
 * nothing else may run alongside the block.
 */
export async function beforeSwitchOn(work: () => Promise<void>): Promise<void> {
  const saved = [SWITCH_ON_FLAG, SWITCH_ON_AT].map(
    (name) => [name, process.env[name]] as const
  );
  process.env[SWITCH_ON_FLAG] = 'false';
  delete process.env[SWITCH_ON_AT];
  try {
    await work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** A DATETIME as UTC text, whatever the process's time zone. */
const utcDatetime = (at: Date) =>
  at.toISOString().slice(0, 19).replace('T', ' ');

/**
 * Consolidated TDH rows into their table, in one statement: every column
 * the row gives, its lists and objects as JSON (the table's json columns),
 * its times as UTC text.
 */
export async function insertConsolidatedTdh(rows: ConsolidatedTDH[]) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]) as (keyof ConsolidatedTDH)[];
  const params: Record<string, unknown> = {};
  const values = rows
    .map(
      (row, i) =>
        `(${columns
          .map((column, j) => {
            const value = row[column];
            params[`v${i}_${j}`] =
              value instanceof Date
                ? utcDatetime(value)
                : value !== null && typeof value === 'object'
                  ? JSON.stringify(value)
                  : value;
            return `:v${i}_${j}`;
          })
          .join(', ')})`
    )
    .join(', ');
  await dbSupplier().execute(
    `insert into ${CONSOLIDATED_WALLETS_TDH_TABLE} (${columns.join(', ')}) values ${values}`,
    params
  );
}

/** An identities row without a profile, as a nominated wallet first gets. */
function bareIdentity(wallet: string, profileId: string): IdentityEntity {
  return {
    consolidation_key: wallet,
    primary_address: wallet,
    profile_id: profileId,
    handle: null,
    normalised_handle: null,
    tdh: 0,
    rep: 0,
    cic: 0,
    level_raw: 0,
    pfp: null,
    banner1: null,
    banner2: null,
    classification: null,
    sub_classification: null,
    xtdh: 0,
    produced_xtdh: 0,
    granted_xtdh: 0,
    xtdh_rate: 0,
    basetdh_rate: 0
  };
}

/**
 * Before switch-on (before the mirror's first run, which lists the
 * placeholder profiles):
 * - each placeholder profile of the file: bulkCreateIdentities makes it on
 *   the wallet's identities row, written first with the file's profile id
 *   (bulkCreateIdentities would make a random one for a new wallet);
 * - the TDH-only identity: step B makes it from its consolidated TDH row;
 * - the founder wallet's address-only identity, as a user group made with
 *   the wallet writes it.
 */
export async function writeSiteRowsBeforeSwitchOn(
  placeholders: readonly PlaceholderAtFreezeLine[]
): Promise<void> {
  await beforeSwitchOn(async () => {
    await dbSupplier().executeNativeQueriesInTransaction(async (connection) => {
      await identitiesDb.bulkInsertIdentities(
        placeholders.map((it) => bareIdentity(it.wallet, it.profile_id)),
        connection
      );
      await identitiesService.bulkCreateIdentities(
        placeholders.map((it) => it.wallet),
        { connection }
      );
    });
    await insertConsolidatedTdh([
      consolidatedTdhRow(W.tdhOnly, SITE_TDH.tdhOnly)
    ]);
    await dbSupplier().executeNativeQueriesInTransaction((connection) =>
      identityConsolidationEffects.syncIdentitiesWithTdhConsolidations(
        connection
      )
    );
    await writeAddressOnlyIdentity(W.founder, IDENTITY_WORLD_ADOPTED_ID);
  });
}

/**
 * The rows IdentitiesDb.insertIdentitiesOnAddressesOnly writes for a wallet
 * a user group names that has no identity yet (the wallet as its key, no
 * TDH, every other column its default), with the given id where it takes a
 * random one.
 */
async function writeAddressOnlyIdentity(
  wallet: string,
  profileId: string
): Promise<void> {
  const params = { wallet, profileId };
  await dbSupplier().executeNativeQueriesInTransaction(async (connection) => {
    await dbSupplier().execute(
      `insert into ${IDENTITIES_TABLE}
         (profile_id, consolidation_key, primary_address, tdh, rep, cic, level_raw)
       values (:profileId, :wallet, :wallet, 0, 0, 0, 0)`,
      params,
      { wrappedConnection: connection }
    );
    await dbSupplier().execute(
      `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
       values (:wallet, :wallet)`,
      params,
      { wrappedConnection: connection }
    );
  });
}

/**
 * After switch-on: TDH on the site TDH identity and on the untaken
 * placeholder with TDH, through the scoped metrics sync from their
 * consolidated TDH rows (tdh and basetdh_rate only).
 */
export async function writeSiteRowsAfterSwitchOn(): Promise<void> {
  await insertConsolidatedTdh([
    consolidatedTdhRow(W.siteTdh, SITE_TDH.siteTdh),
    consolidatedTdhRow(W.untakenTdh, SITE_TDH.untakenTdh)
  ]);
  const result = await identityMetricsSync.syncScoped({
    consolidationKeys: [W.siteTdh, W.untakenTdh],
    profileIds: []
  });
  if (!result.complete) {
    throw new Error(
      `The scoped metrics sync did not finish: ${JSON.stringify(result)}`
    );
  }
}

/**
 * After switch-on: TDH on the waves world's people (WAVES_PEOPLE_TDH), the
 * same way, so their votes and wave ratings have credit: a consolidated
 * TDH row on each one's consolidation key, with that key's wallets, then
 * the scoped metrics sync. The people come from the chain, so a recording
 * without the waves world holds none of them: then nothing is written and
 * 0 returned. One holding only some is not a recording this seed knows,
 * and is refused.
 */
export async function writeWavesPeopleTdh(): Promise<number> {
  const people = WAVES_PEOPLE_TDH;
  const db = dbSupplier();
  const rows = await db.execute<{
    profile_id: string;
    consolidation_key: string;
  }>(
    `select profile_id, consolidation_key from ${IDENTITIES_TABLE}
     where profile_id in (:ids)`,
    { ids: people.map((it) => it.profileId) }
  );
  const keyOf = new Map(
    rows.map((it) => [it.profile_id.toLowerCase(), it.consolidation_key])
  );
  if (!rows.length) return 0;
  const missing = people.filter((it) => !keyOf.has(it.profileId.toLowerCase()));
  if (missing.length || rows.length !== people.length) {
    throw new Error(
      `The recording holds ${rows.length} identities rows for the waves world's ${people.length} people with TDH, missing ${missing.map((it) => it.profileId).join(', ') || 'none'}: not a recording this seed knows`
    );
  }
  const keys = people.map((it) => keyOf.get(it.profileId.toLowerCase())!);
  const addresses = await db.execute<{
    address: string;
    consolidation_key: string;
  }>(
    `select address, consolidation_key from ${ADDRESS_CONSOLIDATION_KEY}
     where consolidation_key in (:keys)`,
    { keys }
  );
  const tdhRows = people.map((person, i) => {
    const wallets = addresses
      .filter((it) => it.consolidation_key === keys[i])
      .map((it) => it.address)
      .sort((a, b) => (a < b ? -1 : Number(a > b)));
    if (!wallets.length) {
      throw new Error(`${person.profileId}'s key ${keys[i]} has no wallets`);
    }
    return consolidatedTdhRowOf(keys[i], wallets, person.tdh);
  });
  await insertConsolidatedTdh(tdhRows);
  const result = await identityMetricsSync.syncScoped({
    consolidationKeys: keys,
    profileIds: []
  });
  if (!result.complete) {
    throw new Error(
      `The scoped metrics sync did not finish: ${JSON.stringify(result)}`
    );
  }
  return people.length;
}
