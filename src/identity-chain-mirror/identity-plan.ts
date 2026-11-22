import { createHash } from 'node:crypto';
import { consolidationTools } from '@/consolidation-tools';
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
  /** Another profile holding the handle the identity should have. */
  readonly handleHolder: {
    readonly external_id: string;
    readonly primary_wallet: string;
  } | null;
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
  readonly pairs: { wallet1: string; wallet2: string }[];
  /** Wallets whose identity changed: their delegation rows follow. */
  readonly touchedWallets: string[];
}

export function consolidationKeyOf(wallets: readonly string[]): string {
  return consolidationTools.buildConsolidationKey([...wallets]);
}

export function placeholderHandle(wallet: string): string {
  return `id-${wallet.toLowerCase()}`;
}

/**
 * The 6529.io profile id of a chain identity that has none (one made on the
 * chain): a UUID derived from the principal id, so a rebuild gives the same.
 */
export function principalProfileId(principalId: string): string {
  const digest = createHash('sha256')
    .update('6529.ChainProfileId.v1')
    .update(Buffer.from(principalId.toLowerCase().replace(/^0x/, ''), 'hex'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8: custom
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
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

/** The handle the profile gets: the chain's, else its placeholder. */
function profileHandle(
  chain: ChainIdentityView,
  current: ProfileRowState | null
): string {
  if (chain.handle) {
    return chain.handle;
  }
  if (current?.handle.toLowerCase().startsWith('id-0x')) {
    return current.handle;
  }
  return placeholderHandle(chain.primary);
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

export function planIdentity(
  chain: ChainIdentityView,
  state: CurrentIdentityState
): IdentityPlan {
  const wallets = uniqueSorted(chain.wallets);
  const key = consolidationKeyOf(wallets);
  const primary = chain.primary.toLowerCase();
  const oldWallets = uniqueSorted(
    state.rows.flatMap((row) => state.walletsByKey[row.consolidation_key] ?? [])
  );
  const leavers = oldWallets.filter((it) => !wallets.includes(it));
  const current = state.profile;
  const handle = profileHandle(chain, current);
  const normalised = handle.toLowerCase();
  const doc = chain.doc;
  const ownRow = state.rows.find((it) => it.profile_id === chain.profileId);
  const metrics = carriedMetrics(chain, state.rows);
  const levelRaw =
    chain.levelRaw ?? chain.rep + Number(metrics.tdh) + Number(metrics.xtdh);
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
  let releaseHandle: IdentityPlan['releaseHandle'] = null;
  if (holder && holder.external_id !== chain.profileId) {
    const placeholder = placeholderHandle(holder.primary_wallet);
    releaseHandle = {
      external_id: holder.external_id,
      handle:
        placeholder === normalised
          ? `id-${holder.external_id.toLowerCase()}`
          : placeholder
    };
  }
  const deleteKeys = uniqueSorted(
    state.rows.map((it) => it.consolidation_key)
  ).filter((it) => it !== key);
  const pairs: { wallet1: string; wallet2: string }[] = [];
  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      pairs.push({ wallet1: wallets[i], wallet2: wallets[j] });
    }
  }
  return {
    deleteKeys,
    identity,
    soloRows: leavers.map(soloRow),
    addressKeys: [
      ...wallets.map((address) => ({ address, consolidation_key: key })),
      ...leavers.map((address) => ({ address, consolidation_key: address }))
    ],
    profile,
    releaseHandle,
    statements: doc === undefined ? null : (doc?.statements ?? []),
    pairWallets: uniqueSorted([...wallets, ...oldWallets]),
    pairs,
    touchedWallets: uniqueSorted([...wallets, ...leavers])
  };
}
