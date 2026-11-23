import {
  cidOf,
  compareText,
  consolidationKeyOf,
  tokenRoot,
  walletRoot
} from './p28';
import { TdhChainDay, TdhDayHeader } from './tdh-chain.types';

/**
 * Checks that a TDH day read from the gateway (or a file) hangs together
 * before anything uses it: the lists' order, counts and roots against the
 * header, each cluster's cid and size, and the header's totals. A day that
 * fails any check is not used.
 *
 * The roots prove the lists are the ones the header commits to. Trust in the
 * header itself comes from the Ethereum cutoff check below and, while it
 * exists, the site's own recompute; a proof from a finalized checkpoint
 * joins when the gateway serves one.
 */

export type ChainDayCheck =
  | 'BOUNDARY'
  | 'WALLET_ORDER'
  | 'WALLET_COUNT'
  | 'WALLET_ROOT'
  | 'CLUSTER_CONSISTENT'
  | 'CLUSTER_SIZE'
  | 'CLUSTER_CID'
  | 'IDENTITY_COUNT'
  | 'TOTAL_TDH'
  | 'TOKEN_ORDER'
  | 'TOKEN_COUNT'
  | 'TOKEN_ROOT'
  | 'TOKEN_CID'
  | 'TOKEN_ZERO'
  | 'ETH_CUTOFF';

export interface ChainDayFailure {
  readonly check: ChainDayCheck;
  readonly detail: string;
}

/** One identity of the day: a cid and its wallets, ascending. */
export interface ChainCluster {
  readonly cid: string;
  readonly wallets: readonly string[];
  /** 6529.io's key for the same wallets. */
  readonly key: string;
  readonly identityTdh: number;
}

export interface ChainDayVerification {
  readonly ok: boolean;
  readonly failures: readonly ChainDayFailure[];
  readonly clusters: ReadonlyMap<string, ChainCluster>;
  readonly walletRoot: string;
  readonly tokenRoot: string | null;
}

const DETAILS_PER_CHECK = 20;

class Failures {
  readonly list: ChainDayFailure[] = [];
  private readonly counts = new Map<ChainDayCheck, number>();

  add(check: ChainDayCheck, detail: string) {
    const n = (this.counts.get(check) ?? 0) + 1;
    this.counts.set(check, n);
    if (n <= DETAILS_PER_CHECK) this.list.push({ check, detail });
    else if (n === DETAILS_PER_CHECK + 1) {
      this.list.push({ check, detail: 'more failures of this check left out' });
    }
  }
}

function compareTokenKeys(
  a: { cid: string; contract: string; tokenId: string },
  b: { cid: string; contract: string; tokenId: string }
): number {
  if (a.cid !== b.cid) return a.cid < b.cid ? -1 : 1;
  if (a.contract !== b.contract) return a.contract < b.contract ? -1 : 1;
  const x = BigInt(a.tokenId);
  const y = BigInt(b.tokenId);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

export function verifyChainDay(day: TdhChainDay): ChainDayVerification {
  const f = new Failures();
  const h = day.header;
  if (h.boundary !== h.cycleDay * 86400) {
    f.add(
      'BOUNDARY',
      `boundary ${h.boundary} is not cycle day ${h.cycleDay} x 86400`
    );
  }

  const leaves = day.walletLeaves;
  for (let i = 1; i < leaves.length; i++) {
    if (!(leaves[i - 1].wallet < leaves[i].wallet)) {
      f.add(
        'WALLET_ORDER',
        `leaf ${i} (${leaves[i].wallet}) is not above leaf ${i - 1}`
      );
    }
  }
  if (leaves.length !== h.walletCount) {
    f.add(
      'WALLET_COUNT',
      `${leaves.length} leaves, header says ${h.walletCount}`
    );
  }
  const computedWalletRoot = walletRoot(leaves);
  if (computedWalletRoot !== h.walletRoot) {
    f.add(
      'WALLET_ROOT',
      `leaves give ${computedWalletRoot}, header says ${h.walletRoot}`
    );
  }

  const groups = new Map<
    string,
    { wallets: string[]; identityTdh: number; walletCount: number }
  >();
  for (const leaf of leaves) {
    const g = groups.get(leaf.cid);
    if (!g) {
      groups.set(leaf.cid, {
        wallets: [leaf.wallet],
        identityTdh: leaf.identityTdh,
        walletCount: leaf.walletCount
      });
      continue;
    }
    g.wallets.push(leaf.wallet);
    if (
      g.identityTdh !== leaf.identityTdh ||
      g.walletCount !== leaf.walletCount
    ) {
      f.add(
        'CLUSTER_CONSISTENT',
        `cid ${leaf.cid}: leaves disagree on identityTDH or walletCount`
      );
    }
  }
  const clusters = new Map<string, ChainCluster>();
  let total = 0;
  for (const [cid, g] of Array.from(groups.entries())) {
    const wallets = g.wallets.slice().sort(compareText);
    if (wallets.length !== g.walletCount) {
      f.add(
        'CLUSTER_SIZE',
        `cid ${cid}: ${wallets.length} leaves, walletCount ${g.walletCount}`
      );
    } else if (cidOf(wallets) !== cid) {
      f.add(
        'CLUSTER_CID',
        `cid ${cid} is not the cid of its ${wallets.length} wallets`
      );
    }
    total += g.identityTdh;
    clusters.set(cid, {
      cid,
      wallets,
      key: consolidationKeyOf(wallets),
      identityTdh: g.identityTdh
    });
  }
  if (clusters.size !== h.identityCount) {
    f.add(
      'IDENTITY_COUNT',
      `${clusters.size} cids, header says ${h.identityCount}`
    );
  }
  if (total !== h.totalTdh) {
    f.add('TOTAL_TDH', `identities sum to ${total}, header says ${h.totalTdh}`);
  }

  let computedTokenRoot: string | null = null;
  if (day.tokenLeaves) {
    const tokens = day.tokenLeaves;
    for (let i = 1; i < tokens.length; i++) {
      if (compareTokenKeys(tokens[i - 1], tokens[i]) >= 0) {
        f.add(
          'TOKEN_ORDER',
          `token leaf ${i} is not above token leaf ${i - 1}`
        );
      }
    }
    if (tokens.length !== h.tokenCount) {
      f.add(
        'TOKEN_COUNT',
        `${tokens.length} token leaves, header says ${h.tokenCount}`
      );
    }
    computedTokenRoot = tokenRoot(tokens);
    if (computedTokenRoot !== h.tokenRoot) {
      f.add(
        'TOKEN_ROOT',
        `token leaves give ${computedTokenRoot}, header says ${h.tokenRoot}`
      );
    }
    for (const t of tokens) {
      if (!clusters.has(t.cid)) {
        f.add(
          'TOKEN_CID',
          `token ${t.contract}/${t.tokenId}: cid ${t.cid} has no wallet leaf`
        );
      }
      if (t.tokenTdh <= 0) {
        f.add(
          'TOKEN_ZERO',
          `token ${t.contract}/${t.tokenId} of ${t.cid} has no TDH`
        );
      }
    }
  }

  return {
    ok: f.list.length === 0,
    failures: f.list,
    clusters,
    walletRoot: computedWalletRoot,
    tokenRoot: computedTokenRoot
  };
}

export interface EthBlockReader {
  getBlock(n: number): Promise<{ hash: string; timestamp: number }>;
}

/**
 * The day's cutoff against Ethereum, through the caller's RPC: block
 * `cutoffNumber` has the header's hash and time, its time is before the
 * boundary, and the next block's is not.
 */
export async function verifyCutoff(
  header: TdhDayHeader,
  eth: EthBlockReader
): Promise<ChainDayFailure[]> {
  const failures: ChainDayFailure[] = [];
  const block = await eth.getBlock(header.cutoffNumber);
  const next = await eth.getBlock(header.cutoffNumber + 1);
  if (block.hash.toLowerCase() !== header.cutoffHash) {
    failures.push({
      check: 'ETH_CUTOFF',
      detail: `block ${header.cutoffNumber} has hash ${block.hash}, header says ${header.cutoffHash}`
    });
  }
  if (block.timestamp !== header.cutoffTimestamp) {
    failures.push({
      check: 'ETH_CUTOFF',
      detail: `block ${header.cutoffNumber} has time ${block.timestamp}, header says ${header.cutoffTimestamp}`
    });
  }
  if (
    !(block.timestamp < header.boundary && next.timestamp >= header.boundary)
  ) {
    failures.push({
      check: 'ETH_CUTOFF',
      detail: `block ${header.cutoffNumber} is not the last block before ${header.boundary}`
    });
  }
  return failures;
}
