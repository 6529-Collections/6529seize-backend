import {
  AreaManifest,
  PlannedRows,
  Probe,
  RebuildStep,
  TableEntry
} from '@/rebuild/manifest.types';
import { PROBE_CALLER } from '@/rebuild/manifests/probe-fixture';
import { PLACEHOLDER_REFERENCE_TABLES } from '@/identity-chain-mirror/rebuild-world/placeholder-references';
import {
  IDENTITY_WORLD_CATEGORIES,
  IDENTITY_WORLD_HANDLES,
  IDENTITY_WORLD_LEGACY_IDS,
  IDENTITY_WORLD_PLACEHOLDER_IDS,
  IDENTITY_WORLD_WALLETS,
  WAVES_PEOPLE_TDH
} from '@/identity-chain-mirror/rebuild-world/world-ids';

const MIRROR_MODULE = 'src/identity-chain-mirror/identity-chain-mirror.rebuild';

/**
 * The tables the identity mirror writes (src/identity-chain-mirror): its own
 * identity_chain_ tables, and the 6529.io identity tables it is the only
 * writer of from switch-on. Its membership handler's holdings queue
 * (transfer_reconciliations) is the holdings area's, and the rebuild runs
 * the mirror without it (identity-chain-mirror.rebuild.ts).
 */
const MIRROR_TABLES = [
  'identity_chain_principals',
  'identity_chain_founder_waits',
  'identity_chain_wallets',
  'identity_chain_placeholders',
  'identity_chain_first_bindings',
  'identity_chain_regroups',
  'identity_chain_rating_ledger',
  'identity_chain_rating_categories',
  'identity_chain_rating_events',
  'identity_chain_mirror_state',
  'identities',
  'profiles',
  'address_consolidation_keys',
  'consolidations',
  'delegations',
  'ratings',
  'cic_statements'
];

const MIRROR_CLOCK =
  "The mirror's clock when it wrote the row; the API never shows it.";
/**
 * The clock ruling: values the mirror takes from its clock, or makes up,
 * that the API shows, are EXEMPT by name until a follow-up after the
 * switch-on derives them from block times.
 */
const clockRuling = (what: string) => ({
  reason: `EXEMPT by the clock ruling: ${what}; a follow-up derives it from block times.`
});

/**
 * The date of the follow-ups that end identity's plans: tdh.chain-days
 * (the TDH area) writes identities' tdh from the chain, and identity's
 * rebuilder reads the team's switch-on record once it is pinned
 * (SWITCH_ON_RECORD_PINS, switch-on-record.ts), so the rows only that
 * record carries come back on real data, with the ids they were issued.
 */
const TDH_REBUILD_UNTIL = '2026-11-30';

/**
 * A profile id column's value is not a v5 UUID. SQL can't tell which
 * namespace a v5 id came from, so this leaves out every v5 id; here the
 * only ones are those the mirrors derive from an address. From switch-on,
 * identity's mirror gives a leaving wallet's row such an id and the waves
 * mirror gives one to an address-only identity, and each rebuilds those
 * rows itself. Random ids are v4.
 */
function notAnAddressId(column: string): string {
  return `(${column} is null
            or ${column} not regexp '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')`;
}

/**
 * The rows the switch-on record takes: identities with no handle and no
 * chain identity behind them, and their address keys. Step B of the TDH
 * sync and the address-only writes gave them random profile ids (or none)
 * before switch-on, and nothing issues those ids after it, so no
 * derivation gives them back: they stay missing after a rebuild until the
 * TDH area's rebuild seeds them from the record. Each predicate selects on
 * the seeded side what the record selects, whatever the row's TDH, less
 * the ids the mirrors derive from an address after switch-on. A
 * placeholder's row has a handle, and this step restores it
 * (placeholder-restore.db.test.ts checks these).
 */
export const TDH_ONLY_PLANNED_ROWS: readonly PlannedRows[] = [
  {
    table: 'identities',
    // No handle: a placeholder's row has its profile's handle (id-<wallet>),
    // and the identity rebuild restores it.
    where: `identities.handle is null
            and not exists (select 1 from identity_chain_principals m
                            where m.profile_id = identities.profile_id)
            and ${notAnAddressId('identities.profile_id')}`,
    reason:
      "An identity with no handle and no chain identity from before switch-on (a TDH-only or address-only one), with the random profile id step B of the TDH sync or an address-only write gave it: the rebuilder loads it from the switch-on record, the rebuild world's take until the team's is pinned.",
    until: TDH_REBUILD_UNTIL,
    change:
      "identity's rebuilder reads the team's switch-on record, pinned in SWITCH_ON_RECORD_PINS"
  },
  {
    table: 'address_consolidation_keys',
    where: `exists (select 1 from identities i
                    where i.consolidation_key = address_consolidation_keys.consolidation_key
                      and i.handle is null
                      and not exists (select 1 from identity_chain_principals m
                                      where m.profile_id = i.profile_id)
                      and ${notAnAddressId('i.profile_id')})`,
    reason:
      "The address keys of an identity with no handle and no chain identity from before switch-on: the rebuilder loads them from the switch-on record, the rebuild world's take until the team's is pinned.",
    until: TDH_REBUILD_UNTIL,
    change:
      "identity's rebuilder reads the team's switch-on record, pinned in SWITCH_ON_RECORD_PINS"
  }
];

/** An SQL list of quoted profile ids (made-up UUIDs, nothing to escape). */
const profileIdsIn = (ids: readonly string[]) =>
  `profile_id in (${ids.map((id) => `'${id}'`).join(', ')})`;

/**
 * The TDH on identities rows the seed writes through the TDH loop's
 * metrics sync: tdh and basetdh_rate, which no rebuilder writes yet, so
 * those rows come back with both at 0. Column plans: every other column
 * of them is compared.
 */
export const TDH_COLUMN_PLANS: readonly PlannedRows[] = [
  {
    table: 'identities',
    where: profileIdsIn([
      IDENTITY_WORLD_LEGACY_IDS.siteTdh,
      IDENTITY_WORLD_PLACEHOLDER_IDS.untakenTdh
    ]),
    columns: ['tdh', 'basetdh_rate'],
    reason:
      "TDH the seed gives an imported identity and an untaken placeholder; only the TDH loop's identities sync writes it, and no rebuilder writes identities' tdh yet.",
    until: TDH_REBUILD_UNTIL,
    change: "the TDH area writes identities' tdh from the chain"
  },
  {
    table: 'identities',
    where: profileIdsIn(WAVES_PEOPLE_TDH.map((it) => it.profileId)),
    columns: ['tdh', 'basetdh_rate'],
    reason:
      "TDH the seed gives four of the waves world's voters, the chain's own values; no rebuilder writes identities' tdh yet.",
    until: TDH_REBUILD_UNTIL,
    change: "the TDH area writes identities' tdh from the chain"
  }
];

const MIRROR_TABLE_ENTRIES: Record<string, TableEntry> = {
  identity_chain_principals: {
    class: 'INDEX',
    volatileColumns: [{ column: 'created_at', reason: MIRROR_CLOCK }]
  },
  // Empty unless an identity made on the chain waits for its founding
  // wallet's history; the world's history is whole, so it has none.
  identity_chain_founder_waits: {
    class: 'INDEX',
    volatileColumns: [{ column: 'since', reason: MIRROR_CLOCK }]
  },
  identity_chain_wallets: {
    class: 'INDEX',
    volatileColumns: [{ column: 'updated_at', reason: MIRROR_CLOCK }]
  },
  // 6529.io's placeholder profiles, which the mirror lists from `profiles`
  // before its first write. After a drop there are none to list, so the
  // rebuilder lists them from the "placeholders at freeze" file, which
  // holds the set the mirror's first run lists, then restores the ones no
  // chain identity took (placeholder-restore.ts; the world's fixture,
  // which its seed puts into the run's files, until the freeze writes the
  // real file).
  identity_chain_placeholders: { class: 'INDEX' },
  identity_chain_first_bindings: { class: 'INDEX' },
  // A work queue: the wallets whose key the mirror changed, queued in its
  // own transaction for the delegations loop, which re-keys them and takes
  // them off. Written with the keys, so a rebuild from empty queues every
  // wallet of every consolidation; the seed and the rebuilder take them
  // off at their end as the loop does (without the re-keying, which
  // rewrites other areas' tables). Not EPHEMERAL: the mirror writes it in
  // the same transaction as the keys, and a rebuilder writes only INDEX
  // tables.
  identity_chain_regroups: {
    class: 'INDEX',
    volatileColumns: [
      { column: 'queued_at', reason: MIRROR_CLOCK },
      {
        column: 'started_at',
        reason:
          "The clock when a re-keying batch took the wallets up (regroupsStarted): the delegations loop's, or the seed's and the rebuilder's own when they take the queue off at their end."
      }
    ]
  },
  identity_chain_rating_ledger: { class: 'INDEX' },
  identity_chain_rating_categories: { class: 'INDEX' },
  identity_chain_rating_events: {
    class: 'INDEX',
    volatileColumns: [
      {
        column: 'id',
        reason:
          'Auto-increment; rows match by height, rater, target, matter and category, which are unique.'
      },
      { column: 'created_at', reason: MIRROR_CLOCK }
    ]
  },
  // The mirror's place in the chain: a cursor, and still INDEX, because
  // the rebuilder rewrites it with the tables it describes; kept, a mirror
  // would resume from it instead of rebuilding (docs/rebuild-check.md).
  identity_chain_mirror_state: {
    class: 'INDEX',
    volatileColumns: [
      { column: 'updated_at', reason: MIRROR_CLOCK },
      {
        column: 'last_full_sync_at',
        reason: "When the mirror's full sync ended, by its clock."
      },
      {
        column: 'placeholders_at',
        reason: 'When the mirror listed the placeholder profiles, by its clock.'
      }
    ]
  },
  // Column owners: this rebuilder owns the rows and rep, cic and
  // level_raw. tdh and basetdh_rate are the TDH loop's identities sync's,
  // and no rebuilder writes them yet, so a row the rebuild makes or
  // restores holds 0 there. The four xTDH columns read 0 from switch-on,
  // which zeroes them, and no step writes them (a row the mirror makes
  // starts at 0). The TDH values the seed writes are the rebuilder's
  // column plans (TDH_COLUMN_PLANS), and the TDH-only identities its
  // planned rows (TDH_ONLY_PLANNED_ROWS), until the TDH area can write
  // those columns and identity's rebuilder reads the team's switch-on
  // record.
  identities: { class: 'INDEX' },
  profiles: {
    class: 'INDEX',
    volatileColumns: [
      {
        column: 'created_at',
        ...clockRuling(
          "the profile's creation time, the mirror's clock for a profile it makes"
        )
      },
      {
        column: 'updated_at',
        ...clockRuling("the mirror's clock when it changed the profile")
      },
      // Follow-up: the mirror could record the creating wallet, if the
      // value ever becomes visible.
      {
        column: 'created_by_wallet',
        reason:
          "6529.io-made profiles record their creator's wallet; mirror-inserted ones the primary wallet; never shown by the API"
      }
    ]
  },
  address_consolidation_keys: { class: 'INDEX' },
  consolidations: {
    class: 'INDEX',
    volatileColumns: [
      {
        column: 'created_at',
        ...clockRuling("the mirror's clock for a pair it makes")
      },
      {
        column: 'wallet1_registered_at',
        ...clockRuling("the registration time, the mirror's clock for a pair")
      },
      {
        column: 'wallet2_registered_at',
        ...clockRuling("the registration time, the mirror's clock for a pair")
      }
    ]
  },
  delegations: {
    class: 'INDEX',
    volatileColumns: [
      {
        column: 'created_at',
        ...clockRuling("the mirror's clock for a row it writes")
      }
    ]
  },
  // The mirror writes the whole table: the help bot's credit rows are gone
  // from main (#2550) with their writer (#2549).
  ratings: {
    class: 'INDEX',
    volatileColumns: [
      {
        column: 'last_modified',
        ...clockRuling("the mirror's clock for a rating it writes")
      }
    ]
  },
  cic_statements: {
    class: 'INDEX',
    volatileColumns: [
      {
        column: 'id',
        ...clockRuling('a random id the mirror makes for a statement')
      },
      {
        column: 'crated_at',
        ...clockRuling("the mirror's clock for a statement it writes")
      }
    ]
  }
};

const H = IDENTITY_WORLD_HANDLES;
const W = IDENTITY_WORLD_WALLETS;
/**
 * An identity's tdh where the seed gave it TDH: the rebuild leaves it at 0,
 * the column plan on identities' tdh (TDH_COLUMN_PLANS) lists each row.
 */
const TDH_PLANNED = {
  path: '$.tdh',
  reason:
    "identities.tdh, a column plan until the TDH area writes identities' tdh from the chain (TDH_COLUMN_PLANS); remove with that plan."
};
/** The untaken placeholder's handle, as 6529.io made it. */
const UNTAKEN_HANDLE = `id-${W.untaken}`;
/** The world's identities, by handle: two imported, a pair, one new. */
const HANDLES = [H.probe1, H.probe2, H.pair, H.madeOnChain];
/** One wallet of each. */
const WALLETS = [W.probe1, W.probe2, W.pairB, W.founder];
const RATED = [H.probe1, H.probe2, H.pair];
/** Raw: the probe runner encodes each value into the path. */
const CATEGORIES = [
  IDENTITY_WORLD_CATEGORIES.builder,
  IDENTITY_WORLD_CATEGORIES.tester
];
const REQUEST_TIME = {
  path: '$.profile.created_at',
  reason:
    "main's API answers the request's time here (getProfileAndConsolidationsByIdentity), not a stored one."
};
/**
 * The caller's subscription actions on each contributor, as main gives
 * them.
 */
const SUBSCRIBED_ACTIONS = {
  path: '$.contributors.data[*].profile.subscribed_actions',
  reason:
    "A set: main's API gives the caller's subscription actions in no fixed order."
};
/**
 * Values the API shows that the mirror takes from its own clock, not from
 * the chain: EXEMPT by the clock ruling, as the tables' volatile columns.
 */
const mirrorClock = (column: string, ...paths: string[]) =>
  paths.map((path) => ({
    path,
    reason: `${column}: the mirror's clock, not the chain's; EXEMPT by the clock ruling until block times give it.`
  }));
const RATING_TIMES = mirrorClock(
  'ratings.last_modified',
  '$.data[*].last_modified'
);
/**
 * Lists main's API sorts by ratings.last_modified, the mirror's clock: by
 * it first (recently_updated, the by-rater lists, newest first) or among
 * equal values (the top lists, by REP). Their order is the clock's, so
 * they compare as sets. The limit: each list is cut, an overview's at 10
 * rows and the others at their first page (200 rows by rater by default),
 * so with more rows than that the clock would also choose which rows show,
 * and a set would no longer prove them. The world's lists hold 4 rows at
 * most.
 */
const clockOrdered = (...paths: string[]) =>
  paths.map((path) => ({
    path,
    reason:
      "A set, while the list fits its cut (an overview's 10 rows, or its first page; the world's hold 4 at most): main's API sorts it by ratings.last_modified, first or among equal REP, and that is the mirror's clock (EXEMPT by the clock ruling)."
  }));

/** The identity answers the mirror's tables feed. */
const PROBES: Probe[] = [
  {
    id: 'identity.profile-by-handle',
    path: '/api/profiles/{handle}',
    each: { handle: HANDLES },
    ignore: [REQUEST_TIME]
  },
  {
    id: 'identity.profile-by-wallet',
    path: '/api/profiles/{wallet}',
    each: { wallet: WALLETS },
    ignore: [REQUEST_TIME]
  },
  {
    id: 'identity.handle-availability',
    path: '/api/profiles/{handle}/availability',
    each: { handle: [H.probe1, H.madeOnChain] }
  },
  {
    id: 'identity.og-metadata',
    path: '/api/og-metadata/profiles/{handle}',
    each: { handle: HANDLES },
    ignore: mirrorClock('profiles.created_at', '$.profile.profile_enabled_at')
  },
  {
    id: 'identity.identity',
    path: '/api/identities/{handle}',
    each: { handle: HANDLES }
  },
  {
    id: 'identity.identity-by-wallet',
    path: '/api/identities/by-wallet/{wallet}',
    each: { wallet: WALLETS }
  },
  {
    id: 'identity.identity-search',
    path: '/api/identities?handle=rebuild_&limit=20'
  },
  {
    id: 'identity.community-members',
    path: '/api/community-members?param=rebuild'
  },
  {
    id: 'identity.community-members-top',
    path: '/api/community-members/top?param=rebuild&page_size=20'
  },
  {
    id: 'identity.rep-rating',
    path: '/api/profiles/{handle}/rep/rating?from_identity={rater}&category=Probe%20Builder',
    each: { handle: [H.probe1], rater: [H.probe2, H.pair] }
  },
  {
    id: 'identity.rep-overview',
    path: '/api/profiles/{handle}/rep/overview',
    each: { handle: RATED },
    unordered: [SUBSCRIBED_ACTIONS]
  },
  {
    // Signed in as the fixture's first wallet, whose profile comes from
    // the chain: its own REP given (authenticated_user_contribution).
    id: 'identity.rep-overview-signed-in',
    path: '/api/profiles/{handle}/rep/overview',
    each: { handle: [H.probe2] },
    as: PROBE_CALLER,
    unordered: [SUBSCRIBED_ACTIONS]
  },
  {
    id: 'identity.rep-categories',
    path: '/api/profiles/{handle}/rep/categories',
    each: { handle: RATED }
  },
  {
    id: 'identity.rep-received',
    path: '/api/profiles/{handle}/rep/ratings/received',
    each: { handle: RATED }
  },
  {
    id: 'identity.rep-by-rater',
    path: '/api/profiles/{handle}/rep/ratings/by-rater',
    each: { handle: RATED },
    ignore: RATING_TIMES,
    unordered: clockOrdered('$.data')
  },
  {
    id: 'identity.rep-given',
    path: '/api/profiles/{handle}/rep/ratings/by-rater?given=true',
    each: { handle: [H.probe1, H.probe2, H.madeOnChain] },
    ignore: RATING_TIMES,
    unordered: clockOrdered('$.data')
  },
  {
    id: 'identity.rep-category-contributors',
    path: '/api/profiles/{handle}/rep/categories/{category}/contributors',
    each: { handle: [H.probe1], category: [CATEGORIES[0]] }
  },
  {
    id: 'identity.cic-overview',
    path: '/api/profiles/{handle}/cic/overview',
    each: { handle: RATED },
    unordered: [SUBSCRIBED_ACTIONS]
  },
  {
    id: 'identity.cic-overview-signed-in',
    path: '/api/profiles/{handle}/cic/overview',
    each: { handle: [H.probe2] },
    as: PROBE_CALLER,
    unordered: [SUBSCRIBED_ACTIONS]
  },
  {
    id: 'identity.cic-contributors',
    path: '/api/profiles/{handle}/cic/contributors',
    each: { handle: [H.probe1, H.probe2] }
  },
  {
    id: 'identity.cic-by-rater',
    path: '/api/profiles/{handle}/cic/ratings/by-rater',
    each: { handle: [H.probe1, H.probe2] },
    ignore: RATING_TIMES,
    unordered: clockOrdered('$.data')
  },
  {
    id: 'identity.cic-rating',
    path: '/api/profiles/{handle}/cic/rating/{rater}',
    each: { handle: [H.probe1], rater: [H.probe2] }
  },
  {
    id: 'identity.cic-statements',
    path: '/api/profiles/{handle}/cic/statements',
    each: { handle: [H.probe1, H.probe2] },
    ignore: [
      ...mirrorClock('cic_statements.crated_at', '$[*].crated_at'),
      {
        path: '$[*].id',
        reason:
          "cic_statements.id: a random id the mirror makes, not the chain's; EXEMPT by the clock ruling until it is derived."
      }
    ],
    unordered: [
      {
        path: '$',
        reason:
          "A set: main's API lists a profile's statements in no order (cic.db.ts)."
      }
    ]
  },
  {
    id: 'identity.rep-category',
    path: '/api/rep/categories/{category}/{view}',
    each: {
      category: CATEGORIES,
      view: ['overview', 'ratings', 'recipients', 'givers']
    },
    ignore: mirrorClock(
      'ratings.last_modified',
      '$.data[*].last_modified',
      '$.top_recipients[*].last_modified',
      '$.top_givers[*].last_modified',
      '$.recently_updated[*].last_modified'
    ),
    unordered: clockOrdered(
      '$.data',
      '$.top_recipients',
      '$.top_givers',
      '$.recently_updated'
    )
  },
  {
    id: 'identity.consolidations',
    path: '/api/consolidations/{wallet}',
    each: { wallet: [W.pairA, W.probe1] }
  },
  {
    id: 'identity.delegations',
    path: '/api/delegations/{wallet}',
    each: { wallet: [W.probe1, W.probe2, W.pairA, W.pairB] },
    ignore: mirrorClock('delegations.created_at', '$.data[*].created_at')
  },
  {
    id: 'identity.delegations-by-use-case',
    path: '/api/delegations?use_case={useCase}',
    each: { useCase: ['2', '3', '997'] },
    ignore: mirrorClock('delegations.created_at', '$.data[*].created_at')
  },
  // 6529.io's rows the chain doesn't hold (rebuild-world/site-rows.ts),
  // each on an identity no other probe reads.
  {
    // The identity made on the chain by a wallet with a placeholder
    // profile: the founder rule gives it the placeholder's id, before and
    // after (the placeholders file as the mirror's list).
    id: 'identity.site.founder-placeholder',
    path: '/api/identities/{handle}',
    each: { handle: [H.siteFounder] }
  },
  // The TDH-only identity has no probe: its rows are the rebuilder's
  // planned rows, so its answer would only say it's missing. The change
  // that seeds them from the switch-on record adds the probe back.
  {
    // An imported identity with TDH on 6529.io: everything but its tdh,
    // which is a column plan (TDH_COLUMN_PLANS).
    id: 'identity.site.tdh',
    path: '/api/identities/{handle}',
    each: { handle: [H.siteTdh] },
    ignore: [TDH_PLANNED]
  },
  {
    // A placeholder profile no chain identity takes, made by 6529.io
    // before switch-on and restored from the placeholders file: its
    // profile, and its identities row and wallet.
    id: 'identity.site.untaken-placeholder',
    path: '/api/profiles/{key}',
    each: { key: [UNTAKEN_HANDLE, W.untaken] },
    ignore: [REQUEST_TIME]
  },
  {
    id: 'identity.site.untaken-placeholder-identity',
    path: '/api/identities/by-wallet/{wallet}',
    each: { wallet: [W.untaken] }
  },
  {
    // An untaken placeholder holding TDH: the row comes back from the
    // file, all but its tdh, which is a column plan (TDH_COLUMN_PLANS).
    id: 'identity.site.untaken-placeholder-tdh',
    path: '/api/identities/by-wallet/{wallet}',
    each: { wallet: [W.untakenTdh] },
    ignore: [TDH_PLANNED]
  },
  // References to the untaken placeholder, one of each kind, planted by
  // identity.placeholder-references (rebuild-world/placeholder-references.ts).
  // Provisional, every kind: how many such references 6529.io holds is not
  // counted yet. These read the ones the API shows to others: they find
  // the restored profile through the reference.
  {
    // Its activity logs (made with the profile by the site's code).
    id: 'identity.site.placeholder-logs',
    path: '/api/profile-logs?profile={key}',
    each: { key: [UNTAKEN_HANDLE] }
  },
  {
    // It follows the probe caller; the caller follows it.
    id: 'identity.site.placeholder-followers',
    path: '/api/identity-subscriptions/incoming/IDENTITY/{handle}',
    each: { handle: [H.probe1] }
  },
  {
    id: 'identity.site.placeholder-followed',
    path: '/api/identity-subscriptions/outgoing/IDENTITY',
    as: PROBE_CALLER
  },
  {
    // A notification to the probe caller that names it.
    id: 'identity.site.placeholder-notification',
    path: '/api/notifications',
    as: PROBE_CALLER
  },
  {
    // A proxy it gave the probe caller, and one the caller gave it.
    id: 'identity.site.placeholder-proxies',
    path: '/api/profiles/{handle}/proxies/{view}',
    each: { handle: [H.probe1], view: ['received', 'granted'] }
  }
];

/**
 * 6529.io's rows from before switch-on that the chain doesn't hold (the
 * placeholder profiles of the placeholders file, a TDH-only identity), the
 * mirror run forward to the mark as the delegations loop runs it from
 * switch-on (the probe fixture's wallets get their profiles from the
 * chain), then 6529.io's own writes after it (TDH on an identity and on a
 * placeholder): rebuild-world/site-rows.ts. It writes tdh_consolidation,
 * the TDH area's table, for its own wallets; once the TDH area's seed
 * writes the shared scenario's TDH rows, it provides those too, and this
 * seed stops. The id is kept from the plain-rows seed it replaces, which
 * other areas' seeds wait for. Without a gateway that serves an identity
 * import (another area's run with its own recording) it writes the
 * world's actors (the probes and the identities other areas' seeds read
 * by wallet) as plain rows, through the harness's seedProbeIdentities.
 *
 * The world is a devnet's, captured in the shared gateway recording with
 * the waves area's world (world-ids.ts holds its ids); an identity run
 * replays that recording with its files directory, which holds the
 * profile documents. The seed adds the world's placeholders file to the
 * run's files:
 *
 *   6529 run rebuild:check -- --home <dir> --area identity
 *     --source gateway=replay:<the shared recording>
 *     --source files=<its files directory>
 *
 * (docs/rebuild-check.md, "The identity area").
 */
const SEED: RebuildStep = {
  id: 'identity.probe-profiles',
  run: { module: MIRROR_MODULE, exportName: 'seedIdentityMirror' },
  writes: [...MIRROR_TABLES, 'profile_activity_logs', 'tdh_consolidation'],
  sources: ['gateway', 'files', 'repo'],
  // The mirror's runs at most (MIRROR_AT_MOST_MS, 47 minutes), with room.
  timeoutMinutes: 50
};

const ACTORS_CHECK_SEED: RebuildStep = {
  // Before any other seed: each actor the world holds has the world's
  // fixed profile id and the chain's principal of it, and the probes,
  // whose ids probeProfileId gives without reading, are held.
  id: 'identity.actors-check',
  run: {
    module: 'src/rebuild/run/probe-fixture.steps',
    exportName: 'checkWorldActorsStep'
  },
  writes: [],
  reads: [
    'identities',
    'address_consolidation_keys',
    'identity_chain_principals'
  ],
  after: ['identity.probe-profiles'],
  sources: ['repo'],
  timeoutMinutes: 5
};

/**
 * One reference of each kind: each table and column of 6529.io's that
 * names a profile, each naming the world's untaken placeholder
 * (rebuild-world/placeholder-references.ts). Every kind is provisional
 * until 6529.io's own counts of such references come. The
 * identity.site.placeholder-* probes read the ones the API shows to
 * others. Most of these tables are other areas': a run keeps them as
 * seeded until their areas rebuild them, and then a reference to an
 * untaken placeholder their rebuild doesn't bring back shows as a
 * difference there.
 */
const REFERENCES_SEED: RebuildStep = {
  id: 'identity.placeholder-references',
  run: { module: MIRROR_MODULE, exportName: 'seedPlaceholderReferences' },
  writes: PLACEHOLDER_REFERENCE_TABLES,
  sources: ['gateway'],
  // The probes it names by their fixed ids are proven held first; a
  // failed check stops the run before this seed plants anything.
  after: ['identity.actors-check'],
  timeoutMinutes: 10
};

/**
 * The mirror's tables from empty, from the 6529 chain and the placeholders
 * file (placeholder-restore.ts). The timeout: the mirror's runs at most
 * (MIRROR_AT_MOST_MS, 47 minutes: 35 to catch up with the chain, then at
 * most 12 for the level walk), and the placeholders: 1,019,000 made-up
 * ones took 28 s to list and 10 minutes to restore on one connection, and
 * the file is read through once more before each (a check of all of it
 * before any write). About 59 minutes in all, with the switch-on record's
 * load (not measured); 75 leaves room.
 */
const REBUILDER: RebuildStep = {
  id: 'identity.chain-mirror',
  run: { module: MIRROR_MODULE, exportName: 'rebuildIdentityMirror' },
  writes: MIRROR_TABLES,
  sources: ['gateway', 'files'],
  // The rebuilders that read the tables it writes (identities, profiles,
  // address_consolidation_keys, identity_chain_principals), declared here
  // as the writer, by the registry's convention. Those not yet in the tree
  // are noted, not refused.
  before: [
    'holdings.ethereum',
    'personal.settings',
    'subs.legacy-history',
    'subs.top-ups',
    'waves.chain-mirror',
    'tdh.chain-days'
  ],
  plannedRows: [...TDH_ONLY_PLANNED_ROWS, ...TDH_COLUMN_PLANS],
  timeoutMinutes: 75
};

/**
 * NFTDelegation's logs after the freeze, from the delegations loop's live
 * log scan on the run's anvil (planned: the module comes with its branch).
 */
const FREEZE_LOGS_REBUILDER: RebuildStep = {
  id: 'identity.nftdelegation-logs-after-freeze',
  run: {
    module: 'src/delegationsLoop/nftdelegation-freeze.rebuild',
    exportName: 'rebuildNftDelegationLogsAfterFreeze'
  },
  writes: ['nftdelegation_logs_after_freeze'],
  sources: ['ethereum'],
  timeoutMinutes: 20,
  origin: 'planned'
};

/**
 * Identity: identities, profiles, handles, consolidations, delegations,
 * REP, NIC, levels and proxies.
 */
export const identityManifest: AreaManifest = {
  area: 'identity',
  // The mirror on, reading the run's gateway; switched on.
  flags: {
    FEATURE_IDENTITY_CHAIN_MIRROR: 'true',
    CHAIN_GATEWAY_URL: '{gateway}',
    FEATURE_IDENTITY_ON_CHAIN: 'true'
  },
  tables: {
    ...MIRROR_TABLE_ENTRIES,
    profiles_archive: { class: 'INDEX' },
    nftdelegation_blocks: {
      class: 'EPHEMERAL',
      why: 'Loop cursor: the last NFTDelegation block read.'
    },
    // NFTDelegation's logs after the freeze, recorded and applied to
    // nothing by the delegations loop: Ethereum's, not the mirror's
    // (identity.nftdelegation-logs-after-freeze, planned).
    nftdelegation_logs_after_freeze: { class: 'INDEX' },
    chain_pending_operations: {
      class: 'EPHEMERAL',
      why: "Identity joins signed by the identity's wallet, held until the joining wallet signs, then relayed: not on the chain until relayed, and they expire within a day."
    },
    chain_pending_operation_signers: {
      class: 'EPHEMERAL',
      why: 'The signatures a held identity join waits for (chain_pending_operations).'
    },
    cic_score_aggregations: { class: 'INDEX' },
    events: {
      class: 'EPHEMERAL',
      why: 'Event queue that the listeners drain.'
    },
    listener_processed_events: {
      class: 'EPHEMERAL',
      why: 'Listener cursors: which events each listener has handled.'
    },
    profile_total_rep_score_aggregations: { class: 'INDEX' },
    rating_credit_locks: {
      class: 'EPHEMERAL',
      why: 'Short-lived locks on rating credit.'
    },
    rep_rating_removals: {
      class: 'EXEMPT',
      why: "audit and undo record of an operator-run one-off job (#2550); written only when an operator applies it; no public source holds it; kept by the database's backups, not by the rebuild"
    },
    // Pending: the over-rates loop's Arweave rates upload writes it.
    // RatingsSnapshot is missing from src/entities/entities.ts, so a fresh
    // schema has no table; registering it there is a one-line fix.
    ratings_snapshots: { class: 'INDEX' },
    profile_proxies: { class: 'INDEX' },
    profile_proxy_actions: { class: 'INDEX' },
    profile_proxy_rating_credit_balances: { class: 'INDEX' },
    profile_activity_logs: { class: 'INDEX' },
    profile_latest_logs: { class: 'INDEX' },
    help_bot_credit_events: { class: 'INDEX' },
    help_bot_daily_activity_credit_requests: { class: 'INDEX' }
  },
  seeds: [SEED, ACTORS_CHECK_SEED, REFERENCES_SEED],
  rebuilders: [REBUILDER, FREEZE_LOGS_REBUILDER],
  probes: PROBES,
  waivers: {
    unprobedTables: [
      ...[
        'identity_chain_principals',
        'identity_chain_wallets',
        'identity_chain_first_bindings',
        'identity_chain_founder_waits',
        'identity_chain_placeholders',
        'identity_chain_regroups',
        'identity_chain_rating_ledger',
        'identity_chain_rating_categories',
        'identity_chain_mirror_state'
      ].map((target) => ({
        target,
        reason:
          "The mirror's own bookkeeping: no API route reads it; the probes read the identity tables it decides."
      })),
      {
        target: 'identity_chain_rating_events',
        reason:
          'The source of REP and NIC notifications from switch-on; no API route reads it before the notification view does.'
      }
    ],
    unseededTables: [
      {
        target: 'identity_chain_regroups',
        reason:
          'A work queue the seed and the rebuilder empty at their end, as the delegations loop does once it has re-keyed the wallets.'
      },
      {
        target: 'identity_chain_founder_waits',
        reason:
          "Rows only while no history can tell an identity made on the chain whether its founding wallet was first bound to it; the world's histories are whole."
      }
    ]
  }
};
