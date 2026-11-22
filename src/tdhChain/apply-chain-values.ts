import { ConsolidatedTDH, NftTDH, TDH } from '@/entities/ITDH';
import { getConsolidationWallets } from '@/tdhLoop/consolidation-wallets';
import { ChainCluster } from './chain-day-verify';
import { cidOf, compareText } from './p28';
import { COLLECTION_CONTRACTS, SITE_COLLECTIONS } from './site-day';
import { TdhChainDay, TdhWalletLeaf } from './tdh-chain.types';

/**
 * Writes the chain's values over the site's own computation of a day. The
 * chain is the source of truth for every TDH total: a wallet's boosted TDH
 * is its leaf's walletTDH, a consolidation's its cluster's identityTDH, a
 * wallet or consolidation without a leaf has 0, and when the day carries
 * token leaves, a consolidation's boosted TDH on a token (and so its
 * per-collection sums) is the token leaf's. Base, raw, boost, balances and
 * the per-season and per-edition rows stay the site's computation.
 *
 * Returns what it changed, so the ingest can record it and rerank.
 */

export interface ChainOverride {
  readonly kind: 'WALLET' | 'IDENTITY' | 'COLLECTION' | 'TOKEN';
  readonly subject: string;
  readonly computed: number;
  readonly chain: number;
}

export interface AppliedChainValues {
  readonly overrides: readonly ChainOverride[];
  /** Leaves the site's computation has no row for; rows were added. */
  readonly addedWallets: readonly string[];
  readonly addedIdentities: readonly string[];
}

function emptyTokenLists() {
  return {
    memes: [],
    memes_ranks: [],
    gradients: [],
    gradients_ranks: [],
    nextgen: [],
    nextgen_ranks: []
  };
}

function zeroFields(block: number, date: Date) {
  return {
    block,
    date,
    tdh: 0,
    boost: 1,
    boosted_tdh: 0,
    tdh__raw: 0,
    tdh_rank: 0,
    tdh_rank_memes: -1,
    tdh_rank_gradients: -1,
    tdh_rank_nextgen: -1,
    balance: 0,
    unique_memes: 0,
    memes_cards_sets: 0,
    genesis: 0,
    nakamoto: 0,
    boosted_memes_tdh: 0,
    memes_tdh: 0,
    memes_tdh__raw: 0,
    memes_balance: 0,
    gradients_balance: 0,
    boosted_gradients_tdh: 0,
    gradients_tdh: 0,
    gradients_tdh__raw: 0,
    nextgen_balance: 0,
    boosted_nextgen_tdh: 0,
    nextgen_tdh: 0,
    nextgen_tdh__raw: 0,
    boost_breakdown: {},
    ...emptyTokenLists()
  };
}

export function applyChainValues(
  day: TdhChainDay,
  clusters: ReadonlyMap<string, ChainCluster>,
  walletRows: TDH[],
  consolidatedRows: ConsolidatedTDH[],
  blockTimestamp: Date
): AppliedChainValues {
  const overrides: ChainOverride[] = [];
  const block = day.header.cutoffNumber;

  const leafOf = new Map<string, TdhWalletLeaf>();
  day.walletLeaves.forEach((l) => leafOf.set(l.wallet, l));
  const seenWallets = new Set<string>();
  for (const row of walletRows) {
    const wallet = row.wallet.toLowerCase();
    seenWallets.add(wallet);
    const chain = leafOf.get(wallet)?.walletTdh ?? 0;
    if (row.boosted_tdh !== chain) {
      overrides.push({
        kind: 'WALLET',
        subject: wallet,
        computed: row.boosted_tdh,
        chain
      });
      row.boosted_tdh = chain;
    }
  }
  const addedWallets: string[] = [];
  for (const leaf of day.walletLeaves) {
    if (seenWallets.has(leaf.wallet)) continue;
    addedWallets.push(leaf.wallet);
    walletRows.push({
      ...zeroFields(block, blockTimestamp),
      wallet: leaf.wallet,
      boosted_tdh: leaf.walletTdh
    } as TDH);
  }

  const clusterByKey = new Map<string, ChainCluster>();
  clusters.forEach((c) => clusterByKey.set(c.key, c));
  const seenKeys = new Set<string>();
  for (const row of consolidatedRows) {
    const key = row.consolidation_key.toLowerCase();
    seenKeys.add(key);
    const chain = clusterByKey.get(key)?.identityTdh ?? 0;
    if (row.boosted_tdh !== chain) {
      overrides.push({
        kind: 'IDENTITY',
        subject: key,
        computed: row.boosted_tdh,
        chain
      });
      row.boosted_tdh = chain;
    }
  }
  const addedIdentities: string[] = [];
  clusters.forEach((c) => {
    if (seenKeys.has(c.key)) return;
    addedIdentities.push(c.key);
    consolidatedRows.push({
      ...zeroFields(block, blockTimestamp),
      consolidation_key: c.key,
      consolidation_display: c.wallets.join(' - '),
      wallets: c.wallets.slice(),
      boosted_tdh: c.identityTdh,
      boosted_tdh_rate: 0
    } as ConsolidatedTDH);
  });

  if (day.tokenLeaves) {
    applyChainTokenSums(day, consolidatedRows, overrides);
  }
  return { overrides, addedWallets, addedIdentities };
}

/** Per-collection boosted sums of each consolidation from the token leaves. */
function applyChainTokenSums(
  day: TdhChainDay,
  consolidatedRows: ConsolidatedTDH[],
  overrides: ChainOverride[]
) {
  const sums = new Map<string, number>();
  for (const t of day.tokenLeaves ?? []) {
    const k = `${t.cid}/${t.contract}`;
    sums.set(k, (sums.get(k) ?? 0) + t.tokenTdh);
  }
  for (const row of consolidatedRows) {
    const wallets = getConsolidationWallets(row)
      .map((w) => w.toLowerCase())
      .sort(compareText);
    const cid = cidOf(wallets);
    for (const c of SITE_COLLECTIONS) {
      const field = `boosted_${c}_tdh` as
        | 'boosted_memes_tdh'
        | 'boosted_gradients_tdh'
        | 'boosted_nextgen_tdh';
      const chain = sums.get(`${cid}/${COLLECTION_CONTRACTS[c]}`) ?? 0;
      if (row[field] !== chain) {
        overrides.push({
          kind: 'COLLECTION',
          subject: `${row.consolidation_key}/${c}`,
          computed: row[field],
          chain
        });
        row[field] = chain;
      }
    }
  }
}

/** Per-card boosted TDH of each consolidation from the token leaves. */
export function applyChainTokenValues(
  day: TdhChainDay,
  nftRows: NftTDH[]
): ChainOverride[] {
  if (!day.tokenLeaves) return [];
  const overrides: ChainOverride[] = [];
  const values = new Map<string, number>();
  for (const t of day.tokenLeaves) {
    values.set(`${t.cid}/${t.contract}/${t.tokenId}`, t.tokenTdh);
  }
  const cidOfKey = new Map<string, string>();
  for (const row of nftRows) {
    const key = row.consolidation_key.toLowerCase();
    let cid = cidOfKey.get(key);
    if (!cid) {
      cid = cidOf(key.split('-').sort(compareText));
      cidOfKey.set(key, cid);
    }
    const chain =
      values.get(`${cid}/${row.contract.toLowerCase()}/${row.id}`) ?? 0;
    if (row.boosted_tdh !== chain) {
      overrides.push({
        kind: 'TOKEN',
        subject: `${key}/${row.contract}/${row.id}`,
        computed: row.boosted_tdh,
        chain
      });
      row.boosted_tdh = chain;
    }
  }
  return overrides;
}
