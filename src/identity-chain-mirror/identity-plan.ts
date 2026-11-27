import { consolidationTools } from '@/consolidation-tools';
import type { MembershipChange } from './membership-change';
import { ProfileDocFields, ProfileDocStatement } from './profile-doc';

/**
 * The 6529 chain is the source of truth for identities from switch-on.
 * 6529.io keeps its identity tables as an index rebuilt from the chain, so
 * the SQL readers (groups, drops, waves, allowlists, airdrops) keep working.
 * This file plans, for one chain identity, the rows that make 6529.io's
 * tables say what the chain says. Pure: the database layer reads the current
 * rows and applies the plan.
 */

/** Ethereum blocks for imported records; chain heights above this base. */
export const CHAIN_BLOCK_BASE = 1_000_000_000;

/** 6529.io's "never expires" for delegations (Unix seconds). */
export const NEVER_EXPIRES = 64_060_588_800;

/** One chain identity as the mirror writes it. */
export interface ChainIdentityView {
  readonly principalId: string;
  /** The 6529.io profile id it maps to (imported: its legacy profile id). */
  readonly profileId: string;
  readonly handle: string | null;
  /** Lowercase, at least one. */
  readonly wallets: string[];
  readonly primary: string;
  /** The profile document's fields; null: none; undefined: keep as is. */
  readonly doc: ProfileDocFields | null | undefined;
  readonly rep: number;
  readonly cic: number;
  readonly levelRaw: number | null;
}

export interface IdentityRowState {
  readonly consolidation_key: string;
  readonly profile_id: string | null;
  readonly primary_address: string;
  readonly handle: string | null;
  readonly normalised_handle: string | null;
  readonly tdh: number;
  readonly rep: number;
  readonly cic: number;
  readonly level_raw: number;
  readonly pfp: string | null;
  readonly banner1: string | null;
  readonly banner2: string | null;
  readonly classification: string | null;
  readonly sub_classification: string | null;
  readonly xtdh: number;
  readonly produced_xtdh: number;
  readonly granted_xtdh: number;
  readonly xtdh_rate: number;
  readonly basetdh_rate: number;
}

export interface ProfileRowState {
  readonly external_id: string;
  readonly handle: string;
  readonly normalised_handle: string;
  readonly primary_wallet: string;
  readonly pfp_url: string | null;
  readonly banner_1: string | null;
  readonly banner_2: string | null;
  readonly website: string | null;
  readonly classification: string | null;
  readonly sub_classification: string | null;
}

/** What 6529.io holds now for the identity's wallets and profile. */
export interface CurrentIdentityState {
  /** Identity rows of the identity's wallets and of its profile. */
  readonly rows: IdentityRowState[];
  /** Each of those rows' wallets (address_consolidation_keys). */
  readonly walletsByKey: Record<string, string[]>;
  readonly profile: ProfileRowState | null;
  /**
   * Another profile holding the identity's chain handle, and the free
   * placeholder it moves to.
   */
  readonly handleHolder: {
    readonly external_id: string;
    readonly releaseHandle: string;
  } | null;
  /** Whether another profile holds the placeholder `id-<primary>`. */
  readonly placeholderTaken: boolean;
}

export type ProfileWrite = Omit<ProfileRowState, 'external_id'> & {
  readonly external_id: string;
  readonly insert: boolean;
};

export interface IdentityPlan {
  /** Identity rows (and their address keys) removed first. */
  readonly deleteKeys: string[];
  readonly identity: IdentityRowState;
  /** Rows for wallets that left the identity: each alone, no profile. */
  readonly soloRows: IdentityRowState[];
  /**
   * Another identity's rows that lost wallets to this one: kept, with their
   * profile and metrics, on their remaining wallets.
   */
  readonly rekeyedRows: IdentityRowState[];
  /** wallet -> consolidation key, for every wallet of the rows written. */
  readonly addressKeys: { address: string; consolidation_key: string }[];
  readonly profile: ProfileWrite;
  /** Another profile that no longer holds the handle: its new handle. */
  readonly releaseHandle: {
    readonly external_id: string;
    readonly handle: string;
  } | null;
  /** The statements to hold; null: leave them as they are. */
  readonly statements: ProfileDocStatement[] | null;
  /** Consolidation pairs of these wallets are replaced by `pairs`. */
  readonly pairWallets: string[];
  readonly pairs: WalletPair[];
  /** Wallets whose identity changed: their delegation rows follow. */
  readonly touchedWallets: string[];
  /**
   * Wallets whose consolidation key changed (a join, a removal, another
   * identity's row re-keyed): 6529.io's consolidated tables re-key them.
   */
  readonly regroupedWallets: string[];
  /**
   * Other profiles whose every wallet joined this identity (usually a
   * joining wallet's placeholder profile): left with no identity row. Their
   * ratings and follows are not moved; the mirror logs them.
   */
  readonly orphanedProfiles: string[];
  /** Each orphaned profile's wallets, all of which joined this identity. */
  readonly orphanedWallets: Readonly<Record<string, readonly string[]>>;
}

export interface WalletPair {
  readonly wallet1: string;
  readonly wallet2: string;
}

/** Every pair of a group of wallets, each pair ascending. */
export function pairsOf(wallets: readonly string[]): WalletPair[] {
  const sorted = uniqueSorted(wallets);
  const pairs: WalletPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      pairs.push({ wallet1: sorted[i], wallet2: sorted[j] });
    }
  }
  return pairs;
}

export function isPlaceholderHandle(handle: string): boolean {
  return handle.toLowerCase().startsWith('id-');
}

export function consolidationKeyOf(wallets: readonly string[]): string {
  return consolidationTools.buildConsolidationKey([...wallets]);
}

export function placeholderHandle(wallet: string): string {
  return `id-${wallet.toLowerCase()}`;
}

/**
 * The 6529.io profile id of an identity made on the chain (an imported one
 * keeps its legacy id): the principal id's first 16 bytes written as a UUID,
 * so a rebuild from the chain gives the same ids.
 */
export function principalProfileId(principalId: string): string {
  const hex = principalId.toLowerCase().replace(/^0x/, '').slice(0, 32);
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Not a principal id: ${principalId}`);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((it) => it.toLowerCase()))).sort(
    (a, b) => (a < b ? -1 : Number(a > b))
  );
}

function zeroMetrics(): Pick<
  IdentityRowState,
  | 'tdh'
  | 'xtdh'
  | 'produced_xtdh'
  | 'granted_xtdh'
  | 'xtdh_rate'
  | 'basetdh_rate'
> {
  return {
    tdh: 0,
    xtdh: 0,
    produced_xtdh: 0,
    granted_xtdh: 0,
    xtdh_rate: 0,
    basetdh_rate: 0
  };
}

function soloRow(wallet: string): IdentityRowState {
  return {
    consolidation_key: wallet,
    profile_id: null,
    primary_address: wallet,
    handle: null,
    normalised_handle: null,
    rep: 0,
    cic: 0,
    level_raw: 0,
    pfp: null,
    banner1: null,
    banner2: null,
    classification: null,
    sub_classification: null,
    ...zeroMetrics()
  };
}

/**
 * The handle the profile gets: the chain's (in the case its owner writes it),
 * else the placeholder it has, else `id-<primary>` (or `id-<profile id>` when
 * another profile holds that).
 */
export function profileHandle(
  chain: ChainIdentityView,
  current: ProfileRowState | null,
  placeholderTaken: boolean
): string {
  if (chain.handle) {
    // The chain's handles are lowercase; the case its owner writes is in the
    // profile document (displayName), else the case 6529.io had.
    const wanted = chain.handle.toLowerCase();
    const display = chain.doc?.displayName;
    if (display?.toLowerCase() === wanted) {
      return display;
    }
    if (current?.handle.toLowerCase() === wanted) {
      return current.handle;
    }
    return chain.handle;
  }
  if (current && isPlaceholderHandle(current.handle)) {
    return current.handle;
  }
  return placeholderTaken
    ? `id-${chain.profileId.toLowerCase()}`
    : placeholderHandle(chain.primary);
}

/** TDH and xTDH stay with the profile until the TDH loops recompute them. */
function carriedMetrics(
  chain: ChainIdentityView,
  rows: readonly IdentityRowState[]
) {
  const own = rows.find((it) => it.profile_id === chain.profileId);
  if (own) {
    return {
      tdh: own.tdh,
      xtdh: own.xtdh,
      produced_xtdh: own.produced_xtdh,
      granted_xtdh: own.granted_xtdh,
      xtdh_rate: own.xtdh_rate,
      basetdh_rate: own.basetdh_rate
    };
  }
  return zeroMetrics();
}

function docColumn(
  doc: ProfileDocFields | null | undefined,
  pick: (fields: ProfileDocFields) => string | null,
  current: string | null
): string | null {
  if (doc === undefined) return current;
  return doc ? pick(doc) : null;
}

/**
 * Another identity's row that held some of this identity's wallets keeps its
 * profile and metrics on the wallets it has left; with none left it goes.
 */
function rekeyOtherRows(
  chain: ChainIdentityView,
  state: CurrentIdentityState,
  ours: ReadonlySet<string>
): {
  rows: IdentityRowState[];
  wallets: Record<string, string[]>;
  orphaned: string[];
  orphanedWallets: Record<string, string[]>;
} {
  const rows: IdentityRowState[] = [];
  const wallets: Record<string, string[]> = {};
  const orphaned: string[] = [];
  const orphanedWallets: Record<string, string[]> = {};
  for (const row of state.rows) {
    if (!row.profile_id || row.profile_id === chain.profileId) continue;
    const remaining = uniqueSorted(
      (state.walletsByKey[row.consolidation_key] ?? []).filter(
        (it) => !ours.has(it.toLowerCase())
      )
    );
    if (!remaining.length) {
      orphaned.push(row.profile_id);
      orphanedWallets[row.profile_id] = uniqueSorted(
        state.walletsByKey[row.consolidation_key] ?? []
      );
      continue;
    }
    const key = consolidationKeyOf(remaining);
    const primary = row.primary_address.toLowerCase();
    rows.push({
      ...row,
      consolidation_key: key,
      primary_address: remaining.includes(primary) ? primary : remaining[0]
    });
    wallets[key] = remaining;
  }
  return { rows, wallets, orphaned, orphanedWallets };
}

/** The wallets whose key differs from the row they were in. */
function regroupedWallets(
  state: CurrentIdentityState,
  next: { address: string; consolidation_key: string }[]
): string[] {
  const before = new Map<string, string>();
  for (const [key, list] of Object.entries(state.walletsByKey)) {
    list.forEach((it) => before.set(it.toLowerCase(), key));
  }
  return uniqueSorted(
    next
      .filter((it) => {
        const old = before.get(it.address);
        return old === undefined
          ? it.consolidation_key !== it.address
          : old !== it.consolidation_key;
      })
      .map((it) => it.address)
  );
}

export function planIdentity(
  chain: ChainIdentityView,
  state: CurrentIdentityState
): IdentityPlan {
  const wallets = uniqueSorted(chain.wallets);
  const ours = new Set(wallets);
  const key = consolidationKeyOf(wallets);
  const primary = chain.primary.toLowerCase();
  const oldWallets = uniqueSorted(
    state.rows.flatMap((row) => state.walletsByKey[row.consolidation_key] ?? [])
  );
  const rekeyed = rekeyOtherRows(chain, state, ours);
  const keptByOthers = new Set(Object.values(rekeyed.wallets).flat());
  const leavers = oldWallets.filter(
    (it) => !ours.has(it) && !keptByOthers.has(it)
  );
  const current = state.profile;
  const handle = profileHandle(chain, current, state.placeholderTaken);
  const normalised = handle.toLowerCase();
  const doc = chain.doc;
  const ownRow = state.rows.find((it) => it.profile_id === chain.profileId);
  const metrics = carriedMetrics(chain, state.rows);
  // The chain's level (REP + TDH); without one from the gateway (a node that
  // lacks the day's lists), the level the row has, rather than a mix.
  const levelRaw = chain.levelRaw ?? Number(ownRow?.level_raw ?? 0);
  const identity: IdentityRowState = {
    consolidation_key: key,
    profile_id: chain.profileId,
    primary_address: primary,
    handle,
    normalised_handle: normalised,
    rep: chain.rep,
    cic: chain.cic,
    level_raw: levelRaw,
    pfp: docColumn(
      doc,
      (it) => it.pfp,
      ownRow?.pfp ?? current?.pfp_url ?? null
    ),
    banner1: docColumn(doc, (it) => it.banner1, ownRow?.banner1 ?? null),
    banner2: docColumn(doc, (it) => it.banner2, ownRow?.banner2 ?? null),
    classification: docColumn(
      doc,
      (it) => it.classification,
      ownRow?.classification ?? null
    ),
    sub_classification: docColumn(
      doc,
      (it) => it.subClassification,
      ownRow?.sub_classification ?? null
    ),
    ...metrics
  };
  const profile: ProfileWrite = {
    insert: !current,
    external_id: chain.profileId,
    handle,
    normalised_handle: normalised,
    primary_wallet: primary,
    pfp_url: identity.pfp,
    banner_1: identity.banner1,
    banner_2: identity.banner2,
    website: docColumn(doc, (it) => it.website, current?.website ?? null),
    classification: identity.classification,
    sub_classification: identity.sub_classification
  };
  const holder = state.handleHolder;
  const releaseHandle =
    chain.handle && holder && holder.external_id !== chain.profileId
      ? { external_id: holder.external_id, handle: holder.releaseHandle }
      : null;
  const deleteKeys = uniqueSorted(
    state.rows.map((it) => it.consolidation_key)
  ).filter((it) => it !== key);
  return {
    deleteKeys,
    identity,
    soloRows: leavers.map(soloRow),
    rekeyedRows: rekeyed.rows,
    addressKeys: [
      ...wallets.map((address) => ({ address, consolidation_key: key })),
      ...Object.entries(rekeyed.wallets).flatMap(([k, list]) =>
        list.map((address) => ({ address, consolidation_key: k }))
      ),
      ...leavers.map((address) => ({ address, consolidation_key: address }))
    ],
    profile,
    releaseHandle,
    statements: doc === undefined ? null : (doc?.statements ?? []),
    orphanedProfiles: uniqueSorted(rekeyed.orphaned),
    orphanedWallets: rekeyed.orphanedWallets,
    pairWallets: uniqueSorted([...wallets, ...oldWallets]),
    pairs: [
      ...pairsOf(wallets),
      ...Object.values(rekeyed.wallets).flatMap((list) => pairsOf(list))
    ],
    touchedWallets: uniqueSorted([...wallets, ...leavers]),
    regroupedWallets: regroupedWallets(state, [
      ...wallets.map((address) => ({ address, consolidation_key: key })),
      ...Object.entries(rekeyed.wallets).flatMap(([k, list]) =>
        list.map((address) => ({ address, consolidation_key: k }))
      ),
      ...leavers.map((address) => ({ address, consolidation_key: address }))
    ])
  };
}

/**
 * The membership change a plan makes, or null when no wallet's key changes:
 * the wallets of every row before and after, each with its key before and
 * after (a wallet with no row before keys to itself).
 */
export function membershipChangeOf(
  plan: IdentityPlan,
  state: CurrentIdentityState,
  height: number
): MembershipChange | null {
  if (!plan.regroupedWallets.length) return null;
  const keysBefore: Record<string, string> = {};
  for (const [key, list] of Object.entries(state.walletsByKey)) {
    list.forEach((it) => (keysBefore[it.toLowerCase()] = key));
  }
  const keysAfter: Record<string, string> = {};
  plan.addressKeys.forEach(
    (it) => (keysAfter[it.address.toLowerCase()] = it.consolidation_key)
  );
  const wallets = uniqueSorted([
    ...Object.keys(keysBefore),
    ...Object.keys(keysAfter)
  ]);
  for (const wallet of wallets) {
    keysBefore[wallet] = keysBefore[wallet] ?? wallet;
    keysAfter[wallet] = keysAfter[wallet] ?? keysBefore[wallet];
  }
  return { height, wallets, keysBefore, keysAfter };
}
