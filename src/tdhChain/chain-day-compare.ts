import { NULL_ADDRESS, NULL_ADDRESS_DEAD } from '@/constants';
import { ChainDayFailure, verifyChainDay } from './chain-day-verify';
import {
  cidOf,
  compareText,
  tokenLeafHash,
  listRoot,
  TOKEN_ROOT_CLASS,
  walletRoot
} from './p28';
import {
  COLLECTION_CONTRACTS,
  dateOfCycleDay,
  SiteDay,
  SiteIdentityRow,
  siteTokenBoostedTdh
} from './site-day';
import { TdhChainDay, TdhTokenLeaf, TdhWalletLeaf } from './tdh-chain.types';

/**
 * Compares a TDH day on the 6529 chain with 6529.io's values for the same
 * day, exactly. Every difference is listed by class. The verdict is MATCH
 * only when the chain's day verifies, no class has an entry, and the wallet
 * and token roots rebuilt from the site's values equal the chain's. With no
 * token list on the chain side it is at most MATCH_WITHOUT_TOKENS: per-card
 * values were not compared.
 *
 * Which site rows must have a leaf follows P28 4.3: a wallet with TDH, a
 * positive balance of a counted token, or in a consolidation of two or more
 * wallets. A site row outside that, with zero TDH, is counted under
 * `siteRowsWithoutLeaf` and is not a difference.
 *
 * The burn addresses (zero and dead) count like any wallet (owner's rule).
 * When the chain's day has no leaf for one the site counts, the wallet and
 * its tokens go under BURN_MISSING_ON_CHAIN rather than the general
 * classes, and a note says whether the totals and counts differ by exactly
 * those rows. That is still a MISMATCH.
 */

const BURN_ADDRESSES = new Set([
  NULL_ADDRESS.toLowerCase(),
  NULL_ADDRESS_DEAD.toLowerCase()
]);

export type DiffClass =
  | 'BLOCK'
  | 'DATE'
  | 'WALLET_MISSING_ON_SITE'
  | 'WALLET_EXTRA_ON_SITE'
  | 'BURN_MISSING_ON_CHAIN'
  | 'WALLET_TDH'
  | 'WALLET_CLUSTER'
  | 'IDENTITY_MISSING_ON_SITE'
  | 'IDENTITY_EXTRA_ON_SITE'
  | 'IDENTITY_TDH'
  | 'TOTAL_TDH'
  | 'IDENTITY_COUNT'
  | 'WALLET_COUNT'
  | 'TOKEN_MISSING_ON_SITE'
  | 'TOKEN_EXTRA_ON_SITE'
  | 'TOKEN_TDH';

export const DIFF_CLASSES: readonly DiffClass[] = [
  'BLOCK',
  'DATE',
  'WALLET_MISSING_ON_SITE',
  'WALLET_EXTRA_ON_SITE',
  'BURN_MISSING_ON_CHAIN',
  'WALLET_TDH',
  'WALLET_CLUSTER',
  'IDENTITY_MISSING_ON_SITE',
  'IDENTITY_EXTRA_ON_SITE',
  'IDENTITY_TDH',
  'TOTAL_TDH',
  'IDENTITY_COUNT',
  'WALLET_COUNT',
  'TOKEN_MISSING_ON_SITE',
  'TOKEN_EXTRA_ON_SITE',
  'TOKEN_TDH'
];

export type CompareVerdict = 'MATCH' | 'MATCH_WITHOUT_TOKENS' | 'MISMATCH';

export interface Difference {
  /** A wallet, a consolidation key, a token as `cid/contract/id`, or the day. */
  readonly subject: string;
  readonly chain: string | number | null;
  readonly site: string | number | null;
}

export interface CompareReport {
  readonly verdict: CompareVerdict;
  readonly cycleDay: number;
  readonly date: string;
  readonly chain: {
    readonly cutoffNumber: number;
    readonly walletRoot: string;
    readonly tokenRoot: string;
    readonly walletCount: number;
    readonly identityCount: number;
    readonly totalTdh: number;
    readonly tokenCount: number;
    readonly tokensServed: boolean;
    readonly verified: boolean;
    readonly failures: readonly ChainDayFailure[];
  };
  readonly site: {
    readonly block: number;
    readonly date: string;
    readonly walletRows: number;
    readonly identityRows: number;
    readonly walletsWithLeaf: number;
    readonly identitiesWithCluster: number;
    readonly totalTdh: number;
    /** The wallet root rebuilt from the site's values; equal roots prove equal lists. */
    readonly walletRootFromSite: string;
    readonly tokenRootFromSite: string | null;
    readonly siteRowsWithoutLeaf: number;
  };
  readonly counts: Readonly<Record<DiffClass, number>>;
  readonly differences: Readonly<Record<DiffClass, readonly Difference[]>>;
  readonly notes: readonly string[];
}

export interface CompareOptions {
  /** Differences kept per class in the report (counts are always whole). */
  readonly keepPerClass?: number;
}

class Diffs {
  readonly counts = {} as Record<DiffClass, number>;
  readonly lists = {} as Record<DiffClass, Difference[]>;

  constructor(private readonly keep: number) {
    for (const c of DIFF_CLASSES) {
      this.counts[c] = 0;
      this.lists[c] = [];
    }
  }

  add(cls: DiffClass, d: Difference) {
    this.counts[cls]++;
    if (this.lists[cls].length < this.keep) this.lists[cls].push(d);
  }

  any(): boolean {
    return DIFF_CLASSES.some((c) => this.counts[c] > 0);
  }
}

function tokenKey(cid: string, contract: string, tokenId: string): string {
  return `${cid}/${contract}/${tokenId}`;
}

/** The site's identity token values: boosted per token, above zero. */
function siteTokenValues(
  identity: SiteIdentityRow,
  cid: string
): Map<string, number> {
  const values = new Map<string, number>();
  for (const t of identity.tokens) {
    const v = siteTokenBoostedTdh(t, identity.boost);
    if (v <= 0) continue;
    const k = tokenKey(cid, COLLECTION_CONTRACTS[t.collection], t.tokenId);
    values.set(k, (values.get(k) ?? 0) + v);
  }
  return values;
}

function siteTokenLeaves(values: Map<string, number>): TdhTokenLeaf[] {
  return Array.from(values.entries())
    .map(([k, v]) => {
      const [cid, contract, tokenId] = k.split('/');
      return { cid, contract, tokenId, tokenTdh: v };
    })
    .sort((a, b) => {
      if (a.cid !== b.cid) return compareText(a.cid, b.cid);
      if (a.contract !== b.contract) return compareText(a.contract, b.contract);
      const x = BigInt(a.tokenId);
      const y = BigInt(b.tokenId);
      if (x === y) return 0;
      return x < y ? -1 : 1;
    });
}

interface SiteLeafView {
  readonly siteIdentityOf: ReadonlyMap<string, SiteIdentityRow>;
  readonly siteWallets: ReadonlySet<string>;
  /** Whether P28 4.3 gives the wallet a leaf. */
  readonly needsLeaf: (wallet: string) => boolean;
  /** The wallets that need a leaf, ascending. */
  readonly leafWallets: readonly string[];
  readonly identityKeys: ReadonlySet<string>;
  readonly totalTdh: number;
}

function siteLeafView(site: SiteDay): SiteLeafView {
  const siteIdentityOf = new Map<string, SiteIdentityRow>();
  let totalTdh = 0;
  for (const identity of Array.from(site.identities.values())) {
    totalTdh += identity.boostedTdh;
    for (const w of identity.wallets) siteIdentityOf.set(w, identity);
  }
  const needsLeaf = (wallet: string): boolean => {
    const row = site.wallets.get(wallet);
    const identity = siteIdentityOf.get(wallet);
    return (
      (row !== undefined && (row.boostedTdh > 0 || row.holds)) ||
      (identity !== undefined && identity.wallets.length > 1)
    );
  };
  const siteWallets = new Set<string>([
    ...Array.from(site.wallets.keys()),
    ...Array.from(siteIdentityOf.keys())
  ]);
  const leafWallets = Array.from(siteWallets)
    .filter(needsLeaf)
    .sort(compareText);
  const identityKeys = new Set(
    leafWallets.map((w) => siteIdentityOf.get(w)?.key ?? w)
  );
  return {
    siteIdentityOf,
    siteWallets,
    needsLeaf,
    leafWallets,
    identityKeys,
    totalTdh
  };
}

/**
 * The header fields the site's values give: wallets with a leaf, their
 * identities, and the identities' total. A quick check against a day's
 * header before its lists are at hand.
 */
export function siteHeaderTotals(site: SiteDay): {
  walletCount: number;
  identityCount: number;
  totalTdh: number;
} {
  const view = siteLeafView(site);
  return {
    walletCount: view.leafWallets.length,
    identityCount: view.identityKeys.size,
    totalTdh: view.totalTdh
  };
}

export function compareChainDay(
  day: TdhChainDay,
  site: SiteDay,
  options: CompareOptions = {}
): CompareReport {
  const diffs = new Diffs(options.keepPerClass ?? 500);
  const notes = [...site.notes];
  const h = day.header;
  const verification = verifyChainDay(day);
  const date = dateOfCycleDay(h.cycleDay);

  if (site.block !== h.cutoffNumber) {
    diffs.add('BLOCK', {
      subject: 'day',
      chain: h.cutoffNumber,
      site: site.block
    });
  }
  if (site.date !== date) {
    diffs.add('DATE', { subject: 'day', chain: date, site: site.date });
  }

  const view = siteLeafView(site);
  const { siteIdentityOf, needsLeaf, siteWallets } = view;

  // Wallets.
  const leafOf = new Map<string, TdhWalletLeaf>();
  for (const leaf of day.walletLeaves) leafOf.set(leaf.wallet, leaf);
  let siteRowsWithoutLeaf = 0;
  for (const leaf of day.walletLeaves) {
    const row = site.wallets.get(leaf.wallet);
    if (!row) {
      diffs.add('WALLET_MISSING_ON_SITE', {
        subject: leaf.wallet,
        chain: leaf.walletTdh,
        site: null
      });
      continue;
    }
    if (row.boostedTdh !== leaf.walletTdh) {
      diffs.add('WALLET_TDH', {
        subject: leaf.wallet,
        chain: leaf.walletTdh,
        site: row.boostedTdh
      });
    }
  }
  const burnMissing = new Set<string>();
  for (const wallet of Array.from(siteWallets)) {
    if (leafOf.has(wallet)) continue;
    if (needsLeaf(wallet) && BURN_ADDRESSES.has(wallet)) {
      burnMissing.add(wallet);
      diffs.add('BURN_MISSING_ON_CHAIN', {
        subject: wallet,
        chain: null,
        site: site.wallets.get(wallet)?.boostedTdh ?? 0
      });
    } else if (needsLeaf(wallet)) {
      diffs.add('WALLET_EXTRA_ON_SITE', {
        subject: wallet,
        chain: null,
        site: site.wallets.get(wallet)?.boostedTdh ?? 0
      });
    } else {
      siteRowsWithoutLeaf++;
    }
  }

  // Identities.
  const matchedKeys = new Set<string>();
  for (const cluster of Array.from(verification.clusters.values())) {
    const identity = site.identities.get(cluster.key);
    if (!identity) {
      diffs.add('IDENTITY_MISSING_ON_SITE', {
        subject: cluster.key,
        chain: cluster.identityTdh,
        site: null
      });
      for (const w of cluster.wallets) {
        const other = siteIdentityOf.get(w);
        if (other) {
          diffs.add('WALLET_CLUSTER', {
            subject: w,
            chain: cluster.key,
            site: other.key
          });
        }
      }
      continue;
    }
    matchedKeys.add(cluster.key);
    if (identity.boostedTdh !== cluster.identityTdh) {
      diffs.add('IDENTITY_TDH', {
        subject: cluster.key,
        chain: cluster.identityTdh,
        site: identity.boostedTdh
      });
    }
  }
  let identitiesWithCluster = 0;
  let siteTotal = 0;
  let burnTdh = 0;
  let burnIdentities = 0;
  const isBurnIdentity = (i: SiteIdentityRow) =>
    i.wallets.length === 1 && burnMissing.has(i.wallets[0]);
  for (const identity of Array.from(site.identities.values())) {
    siteTotal += identity.boostedTdh;
    if (matchedKeys.has(identity.key)) {
      identitiesWithCluster++;
      continue;
    }
    if (isBurnIdentity(identity)) {
      burnTdh += identity.boostedTdh;
      burnIdentities++;
      continue;
    }
    if (identity.boostedTdh > 0 || identity.wallets.some(needsLeaf)) {
      diffs.add('IDENTITY_EXTRA_ON_SITE', {
        subject: identity.key,
        chain: null,
        site: identity.boostedTdh
      });
    }
  }

  // Totals, as the header states them.
  const siteLeafWallets = view.leafWallets;
  const siteIdentityKeys = view.identityKeys;
  if (siteTotal !== h.totalTdh) {
    diffs.add('TOTAL_TDH', {
      subject: 'day',
      chain: h.totalTdh,
      site: siteTotal
    });
  }
  if (siteIdentityKeys.size !== h.identityCount) {
    diffs.add('IDENTITY_COUNT', {
      subject: 'day',
      chain: h.identityCount,
      site: siteIdentityKeys.size
    });
  }
  if (siteLeafWallets.length !== h.walletCount) {
    diffs.add('WALLET_COUNT', {
      subject: 'day',
      chain: h.walletCount,
      site: siteLeafWallets.length
    });
  }
  if (burnMissing.size > 0) {
    const exact =
      siteTotal - burnTdh === h.totalTdh &&
      siteIdentityKeys.size - burnIdentities === h.identityCount &&
      siteLeafWallets.length - burnMissing.size === h.walletCount;
    notes.push(
      exact
        ? `the burn addresses missing on the chain (${burnMissing.size} wallets, ${burnTdh} TDH) are exactly the differences in TOTAL_TDH, IDENTITY_COUNT and WALLET_COUNT`
        : `the burn addresses missing on the chain (${burnMissing.size} wallets, ${burnTdh} TDH) don't explain all of the differences in the totals and counts`
    );
  }

  // The wallet list rebuilt from the site's values.
  const siteLeaves: TdhWalletLeaf[] = siteLeafWallets.map((wallet) => {
    const identity = siteIdentityOf.get(wallet);
    const members = identity ? identity.wallets : [wallet];
    return {
      wallet,
      cid: cidOf(members),
      identityTdh: identity ? identity.boostedTdh : 0,
      walletTdh: site.wallets.get(wallet)?.boostedTdh ?? 0,
      walletCount: members.length
    };
  });
  const walletRootFromSite = walletRoot(siteLeaves);

  // Tokens, when the chain's day has them.
  let tokenRootFromSite: string | null = null;
  if (day.tokenLeaves) {
    const siteValues = new Map<string, number>();
    for (const identity of Array.from(site.identities.values())) {
      const values = siteTokenValues(identity, cidOf(identity.wallets));
      values.forEach((v, k) => siteValues.set(k, v));
    }
    const chainValues = new Map<string, number>();
    for (const t of day.tokenLeaves) {
      chainValues.set(tokenKey(t.cid, t.contract, t.tokenId), t.tokenTdh);
    }
    chainValues.forEach((v, k) => {
      const s = siteValues.get(k);
      if (s === undefined) {
        diffs.add('TOKEN_MISSING_ON_SITE', {
          subject: k,
          chain: v,
          site: null
        });
      } else if (s !== v) {
        diffs.add('TOKEN_TDH', { subject: k, chain: v, site: s });
      }
    });
    const burnCids = new Set(Array.from(burnMissing).map((w) => cidOf([w])));
    siteValues.forEach((v, k) => {
      if (!chainValues.has(k)) {
        diffs.add(
          burnCids.has(k.split('/')[0])
            ? 'BURN_MISSING_ON_CHAIN'
            : 'TOKEN_EXTRA_ON_SITE',
          { subject: k, chain: null, site: v }
        );
      }
    });
    tokenRootFromSite = listRoot(
      TOKEN_ROOT_CLASS,
      siteTokenLeaves(siteValues).map(tokenLeafHash)
    );
  } else {
    notes.push(
      'the chain side has no token list: per-card values not compared'
    );
  }

  const rootsMatch =
    walletRootFromSite === h.walletRoot &&
    (tokenRootFromSite === null || tokenRootFromSite === h.tokenRoot);
  let verdict: CompareVerdict = 'MISMATCH';
  if (verification.ok && !diffs.any() && rootsMatch) {
    verdict = day.tokenLeaves ? 'MATCH' : 'MATCH_WITHOUT_TOKENS';
  }
  if (verification.ok && !diffs.any() && !rootsMatch) {
    notes.push('no record differs, yet a root rebuilt from the site differs');
  }
  if (walletRootFromSite === h.walletRoot && verdict === 'MISMATCH') {
    notes.push('the wallet root rebuilt from the site equals the chain root');
  }
  return {
    verdict,
    cycleDay: h.cycleDay,
    date,
    chain: {
      cutoffNumber: h.cutoffNumber,
      walletRoot: h.walletRoot,
      tokenRoot: h.tokenRoot,
      walletCount: h.walletCount,
      identityCount: h.identityCount,
      totalTdh: h.totalTdh,
      tokenCount: h.tokenCount,
      tokensServed: day.tokenLeaves !== null,
      verified: verification.ok,
      failures: verification.failures
    },
    site: {
      block: site.block,
      date: site.date,
      walletRows: site.wallets.size,
      identityRows: site.identities.size,
      walletsWithLeaf: siteLeafWallets.length,
      identitiesWithCluster,
      totalTdh: siteTotal,
      walletRootFromSite,
      tokenRootFromSite,
      siteRowsWithoutLeaf
    },
    counts: diffs.counts,
    differences: diffs.lists,
    notes
  };
}

/** About ten lines for a person: the verdict, the roots and the counts. */
export function summarizeReport(r: CompareReport): string {
  const lines = [
    `TDH day ${r.date} (cycle day ${r.cycleDay}): ${r.verdict}`,
    `chain: block ${r.chain.cutoffNumber}, ${r.chain.walletCount} wallets, ${r.chain.identityCount} identities, total ${r.chain.totalTdh}, day ${r.chain.verified ? 'verified' : 'FAILED its checks'}`,
    `site:  block ${r.site.block}, ${r.site.walletsWithLeaf} wallets, ${r.site.identitiesWithCluster} matched identities of ${r.site.identityRows}, total ${r.site.totalTdh}`,
    `wallet root: chain ${r.chain.walletRoot}`,
    `             site  ${r.site.walletRootFromSite}`,
    r.chain.tokensServed
      ? `token root: chain ${r.chain.tokenRoot}, site ${r.site.tokenRootFromSite}`
      : 'token list: not served, per-card values not compared',
    `site rows without a leaf (zero TDH, nothing held, alone): ${r.site.siteRowsWithoutLeaf}`
  ];
  const nonzero = DIFF_CLASSES.filter((c) => r.counts[c] > 0);
  lines.push(
    nonzero.length === 0
      ? 'differences: none'
      : `differences: ${nonzero.map((c) => `${c} ${r.counts[c]}`).join(', ')}`
  );
  if (!r.chain.verified) {
    lines.push(
      `chain checks failed: ${Array.from(new Set(r.chain.failures.map((f) => f.check))).join(', ')}`
    );
  }
  for (const n of r.notes) {
    if (n.startsWith('the burn addresses')) lines.push(n);
  }
  if (r.notes.length) lines.push(`notes: ${r.notes.length} (see report.json)`);
  return lines.join('\n') + '\n';
}
