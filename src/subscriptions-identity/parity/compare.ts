import { mergeDuplicateWallets } from '@/api/api-wallet-helpers';
import {
  DelegationRow,
  ResolvedAirdropTarget,
  resolveAirdropTarget
} from '../engine/airdrop-address';
import {
  AirdropTarget,
  buildFinalList,
  FinalListBuild,
  FinalListDecision
} from '../engine/final-list';
import { roundSubscriptionBalance } from '../engine/parity-money';
import {
  applyKnownPhases,
  PhasedFinalRow,
  toPhasedRow,
  WalletAmount
} from '../engine/phase-split';
import { AirdropTransfer, matchRedemptions } from '../engine/redemption';
import { compareText } from '../engine/text-order';
import { LegacyCsvRow, LegacyOutputs } from './legacy-outputs';
import {
  BuildInputs,
  InputNote,
  ParitySnapshot,
  toBuildInputs
} from './snapshot';

/** The chain-side inputs for run 2: Delegation records and wallet TDH. */
export interface ChainInputs {
  readonly version: 1;
  /** Where the records came from, for example a gateway height. */
  readonly source: string;
  /** The build time in Unix seconds, for delegation expiry. */
  readonly nowSeconds: number;
  readonly delegations: DelegationRow[];
  readonly boostedTdhByWallet: Record<string, number>;
  /** Legacy key to identity key, where they differ. */
  readonly keyMap?: Record<string, string>;
}

export type ParityRun = 'run1' | 'run2';

export type DiffCause =
  | 'key-not-collected'
  | 'balance-input'
  | 'eligibility-input'
  | 'card-input'
  | 'row-flag'
  | 'airdrop-input'
  | 'tdh-tie'
  | 'delegation-tie'
  | 'chain-source'
  | 'topup-timing'
  | 'distribution-input'
  | 'unknown';

export interface ParityDiff {
  readonly key: string | null;
  readonly wallet?: string;
  readonly transaction?: string;
  readonly field: string;
  readonly old: unknown;
  readonly new: unknown;
  readonly cause: DiffCause;
}

export interface ParityReport {
  readonly id: string;
  readonly gate: 'LIST' | 'PHASE' | 'REDEMPTIONS';
  readonly run: ParityRun;
  readonly card: number;
  readonly phase: string | null;
  readonly old: {
    readonly rows: number;
    readonly inputs: Record<string, unknown>;
  };
  readonly new: {
    readonly rows: number;
    readonly inputs: Record<string, unknown>;
  };
  readonly verdict: 'MATCH' | 'DIFF';
  readonly positionsDiffer: number;
  readonly diffs: ParityDiff[];
  readonly notes: string[];
}

export interface ParityParams {
  readonly snapshot: ParitySnapshot;
  readonly legacy: LegacyOutputs;
  readonly run: ParityRun;
  readonly buildAtMs: number;
  readonly chain?: ChainInputs;
  /** Overrides the legacy outputs' airdrop mints (an Ethereum fixture). */
  readonly transfers?: readonly AirdropTransfer[];
  /** Use the legacy build's own balance per key (default true). */
  readonly pinBalances?: boolean;
}

function lower(value: string | null | undefined): string | null {
  return value ? value.toLowerCase() : null;
}

function verdictOf(diffs: readonly ParityDiff[]): 'MATCH' | 'DIFF' {
  return diffs.length === 0 ? 'MATCH' : 'DIFF';
}

class KeyMapper {
  constructor(private readonly map: Record<string, string> = {}) {}
  toIdentity(key: string): string {
    const k = key.toLowerCase();
    return (this.map[k] ?? k).toLowerCase();
  }
}

/**
 * Published list keys whose subscription moved to another key after the
 * build: a consolidation change moves the rows and log lines to the new key,
 * but the published file keeps the old one. A list key with no build line of
 * its own maps to the one read key that holds all of its wallets and has the
 * build's ADDED line.
 */
export function rekeyedAfterBuild(
  listKeys: readonly string[],
  readKeys: readonly string[],
  added: ReadonlySet<string>
): Map<string, string> {
  const rekeyed = new Map<string, string>();
  for (const key of listKeys) {
    if (added.has(key)) {
      continue;
    }
    const wallets = key.split('-');
    const holders = readKeys.filter((candidate) => {
      if (candidate === key || !added.has(candidate)) {
        return false;
      }
      const held = new Set(candidate.split('-'));
      return wallets.every((w) => held.has(w));
    });
    if (holders.length === 1) {
      rekeyed.set(key, holders[0]);
    }
  }
  return rekeyed;
}

function listRows(params: ParityParams): {
  rows: LegacyCsvRow[];
  rekeyed: number;
} {
  const rows = params.legacy.csv?.rows ?? [];
  const added = new Set(
    Object.entries(params.legacy.buildDecisions)
      .filter(([, decision]) => decision.kind === 'ADDED')
      .map(([key]) => key)
  );
  const rekey = rekeyedAfterBuild(
    rows.map((r) => r.key),
    params.snapshot.subscribers.map((s) => s.key),
    added
  );
  return {
    rows: rows.map((r) => ({ ...r, key: rekey.get(r.key) ?? r.key })),
    rekeyed: rekey.size
  };
}

function pinnedBalances(
  legacy: LegacyOutputs,
  rows: readonly LegacyCsvRow[]
): Map<string, number | null> {
  const pinned = new Map<string, number | null>();
  for (const [key, decision] of Object.entries(legacy.buildDecisions)) {
    if (decision.kind === 'ADDED' || decision.kind === 'INSUFFICIENT_BALANCE') {
      if (Number.isFinite(decision.balance)) {
        pinned.set(key, decision.balance);
      }
    } else if (decision.kind === 'NO_BALANCE') {
      pinned.set(key, null);
    }
  }
  for (const row of rows) {
    pinned.set(row.key, row.balance);
  }
  return pinned;
}

function laterLogs(legacy: LegacyOutputs) {
  return new Map(Object.entries(legacy.logs));
}

function airdropResolver(
  params: ParityParams,
  mapper: KeyMapper,
  ties: Map<string, ResolvedAirdropTarget['ties']>
): (key: string) => AirdropTarget {
  if (params.run === 'run2') {
    const chain = params.chain;
    if (!chain) {
      throw new Error('run2 needs chain inputs');
    }
    const tdh = new Map(
      Object.entries(chain.boostedTdhByWallet).map(([w, v]) => [
        w.toLowerCase(),
        v
      ])
    );
    return (key) => {
      const resolved = resolveAirdropTarget({
        key: mapper.toIdentity(key),
        delegations: chain.delegations,
        boostedTdhByWallet: tdh,
        nowSeconds: chain.nowSeconds
      });
      if (resolved.ties.length) {
        ties.set(mapper.toIdentity(key), resolved.ties);
      }
      return resolved;
    };
  }
  const byKey = new Map(
    params.snapshot.subscribers.map((s) => [s.key, s.airdrop])
  );
  return (key) => {
    const airdrop = byKey.get(key);
    return {
      airdropAddress: airdrop?.airdropAddress ?? null,
      tdhWallet: airdrop?.tdhWallet ?? null
    };
  };
}

interface FinalListContext {
  readonly build: FinalListBuild;
  readonly inputs: BuildInputs;
  readonly mapper: KeyMapper;
  readonly ties: Map<string, ResolvedAirdropTarget['ties']>;
}

function decisionByKey(
  build: FinalListBuild,
  mapper: KeyMapper
): Map<string, FinalListDecision> {
  return new Map(build.decisions.map((d) => [mapper.toIdentity(d.key), d]));
}

function causeForMissingNew(
  key: string,
  ctx: FinalListContext,
  collected: Set<string>
): DiffCause {
  if (!collected.has(key)) {
    return 'key-not-collected';
  }
  const decision = decisionByKey(ctx.build, ctx.mapper).get(key);
  if (!decision) {
    return 'card-input';
  }
  if (
    decision.kind === 'NO_BALANCE' ||
    decision.kind === 'INSUFFICIENT_BALANCE'
  ) {
    return 'balance-input';
  }
  return 'unknown';
}

function causeForCount(
  key: string,
  ctx: FinalListContext,
  notes: readonly InputNote[]
): DiffCause {
  const decision = decisionByKey(ctx.build, ctx.mapper).get(key);
  if (
    notes.includes('ROW_FLAG_AMBIGUOUS') ||
    notes.includes('ROW_FLAG_UNKNOWN')
  ) {
    return 'row-flag';
  }
  if (
    decision?.kind === 'ADDED' &&
    decision.count === decision.eligibility &&
    decision.eligibility < Math.min(decision.requested, decision.affordable)
  ) {
    return 'eligibility-input';
  }
  return 'unknown';
}

function causeForAirdrop(
  key: string,
  ctx: FinalListContext,
  run: ParityRun
): DiffCause {
  if (run === 'run1') {
    return 'airdrop-input';
  }
  const ties = ctx.ties.get(key) ?? [];
  if (ties.includes('TDH')) {
    return 'tdh-tie';
  }
  if (ties.length) {
    return 'delegation-tie';
  }
  return 'chain-source';
}

function keyNotes(ctx: FinalListContext, key: string): InputNote[] {
  for (const [legacyKey, notes] of Array.from(ctx.inputs.notes.entries())) {
    if (ctx.mapper.toIdentity(legacyKey) === key) {
      return notes;
    }
  }
  return [];
}

/** The card's final list, engine against the published list. */
export function compareFinalList(params: ParityParams): {
  readonly report: ParityReport;
  readonly context: FinalListContext;
} {
  const mapper = new KeyMapper(params.chain?.keyMap);
  const pin = params.pinBalances ?? true;
  const list = listRows(params);
  const inputs = toBuildInputs(params.snapshot, {
    buildAtMs: params.buildAtMs,
    laterLogs: laterLogs(params.legacy),
    pinnedBalances: pin ? pinnedBalances(params.legacy, list.rows) : undefined
  });
  const ties = new Map<string, ResolvedAirdropTarget['ties']>();
  const build = buildFinalList({
    contract: params.snapshot.contract,
    tokenId: params.snapshot.tokenId,
    buildAtMs: params.buildAtMs,
    subscribers: inputs.inputs,
    resolveAirdrop: airdropResolver(params, mapper, ties)
  });
  const context: FinalListContext = { build, inputs, mapper, ties };

  const oldRows = new Map(list.rows.map((r) => [mapper.toIdentity(r.key), r]));
  const newRows = new Map(build.rows.map((r) => [mapper.toIdentity(r.key), r]));
  const collected = new Set(
    params.snapshot.subscribers.map((s) => mapper.toIdentity(s.key))
  );
  const oldDecisions = new Map(
    Object.entries(params.legacy.buildDecisions).map(([k, d]) => [
      mapper.toIdentity(k),
      d
    ])
  );
  const diffs: ParityDiff[] = [];
  let positionsDiffer = 0;
  const keys = Array.from(
    new Set([...Array.from(oldRows.keys()), ...Array.from(newRows.keys())])
  ).sort(compareText);
  for (const key of keys) {
    const o = oldRows.get(key);
    const n = newRows.get(key);
    if (o && !n) {
      diffs.push({
        key,
        field: 'row',
        old: o.count,
        new: null,
        cause: causeForMissingNew(key, context, collected)
      });
      continue;
    }
    if (n && !o) {
      const oldDecision = oldDecisions.get(key);
      diffs.push({
        key,
        field: 'row',
        old: oldDecision?.kind ?? null,
        new: n.subscribedCount,
        cause:
          oldDecision?.kind === 'INSUFFICIENT_BALANCE' ||
          oldDecision?.kind === 'NO_BALANCE'
            ? 'balance-input'
            : 'card-input'
      });
      continue;
    }
    if (!o || !n) {
      continue;
    }
    if (o.count !== n.subscribedCount) {
      diffs.push({
        key,
        field: 'count',
        old: o.count,
        new: n.subscribedCount,
        cause: causeForCount(key, context, keyNotes(context, key))
      });
    }
    if (lower(o.airdropAddress) !== lower(n.airdropAddress)) {
      diffs.push({
        key,
        field: 'airdropAddress',
        old: o.airdropAddress,
        new: n.airdropAddress,
        cause: causeForAirdrop(key, context, params.run)
      });
    }
    if (o.balance !== n.balance) {
      diffs.push({
        key,
        field: 'balance',
        old: o.balance,
        new: n.balance,
        cause: 'balance-input'
      });
    }
    if (o.subscribedAt !== n.subscribedAt) {
      positionsDiffer++;
    }
  }

  const notes: string[] = [];
  const oldTotal = list.rows.reduce((sum, r) => sum + r.count, 0);
  const newTotal = build.rows.reduce((s, r) => s + r.subscribedCount, 0);
  notes.push(`cards: old ${oldTotal}, new ${newTotal}`);
  if (params.legacy.cardCount !== null) {
    notes.push(`count route: ${params.legacy.cardCount}`);
  }
  if (!params.legacy.csv) {
    notes.push('no published list for the card');
  }
  if (list.rekeyed) {
    notes.push(`list keys re-keyed after the build: ${list.rekeyed}`);
  }
  const flagged = Array.from(inputs.notes.values()).filter((n) =>
    n.includes('ROW_FLAG_AMBIGUOUS')
  ).length;
  if (flagged) {
    notes.push(`row flag ambiguous for ${flagged} keys`);
  }
  if (ties.size) {
    notes.push(`ties left to the database's order: ${ties.size} keys`);
  }

  const report: ParityReport = {
    id: `${params.legacy.buildDate}/LIST/${params.run}/${params.snapshot.tokenId}`,
    gate: 'LIST',
    run: params.run,
    card: params.snapshot.tokenId,
    phase: null,
    old: {
      rows: oldRows.size,
      inputs: {
        uploadUrl: params.legacy.csv?.uploadUrl ?? null,
        listDate: params.legacy.csv?.date ?? null
      }
    },
    new: {
      rows: newRows.size,
      inputs: {
        snapshotFrom: new Date(params.snapshot.collectedFromMs).toISOString(),
        snapshotTo: new Date(params.snapshot.collectedToMs).toISOString(),
        buildAt: new Date(params.buildAtMs).toISOString(),
        balances: pin ? 'pinned to the legacy build' : 'snapshot',
        airdrops: params.run === 'run1' ? 'legacy route' : params.chain?.source
      }
    },
    verdict: verdictOf(diffs),
    positionsDiffer,
    diffs,
    notes
  };
  return { report, context };
}

function multisetDiff(
  oldList: readonly WalletAmount[],
  newList: readonly WalletAmount[]
): Array<{ wallet: string; old: number; new: number }> {
  const count = (list: readonly WalletAmount[]) => {
    const m = new Map<string, number[]>();
    for (const e of list) {
      const w = e.wallet.toLowerCase();
      m.set(
        w,
        [...(m.get(w) ?? []), e.amount].sort((a, b) => a - b)
      );
    }
    return m;
  };
  const o = count(oldList);
  const n = count(newList);
  const wallets = Array.from(
    new Set([...Array.from(o.keys()), ...Array.from(n.keys())])
  ).sort(compareText);
  const out: Array<{ wallet: string; old: number; new: number }> = [];
  for (const wallet of wallets) {
    const oa = (o.get(wallet) ?? []).join(',');
    const na = (n.get(wallet) ?? []).join(',');
    if (oa !== na) {
      out.push({
        wallet,
        old: (o.get(wallet) ?? []).reduce((s, v) => s + v, 0),
        new: (n.get(wallet) ?? []).reduce((s, v) => s + v, 0)
      });
    }
  }
  return out;
}

function phasedRows(
  params: ParityParams,
  ctx: FinalListContext
): PhasedFinalRow[] {
  const phaseByKey = new Map<string, string>();
  for (const [key, row] of Object.entries(params.legacy.finalRows)) {
    if (row.phase) {
      phaseByKey.set(ctx.mapper.toIdentity(key), row.phase);
    }
  }
  const rows = ctx.build.rows.map((r) =>
    toPhasedRow({ ...r, key: ctx.mapper.toIdentity(r.key) })
  );
  return applyKnownPhases(rows, phaseByKey);
}

function distributionAirdrops(
  legacy: LegacyOutputs,
  phase: string
): WalletAmount[] | null {
  const entries: WalletAmount[] = [];
  let any = false;
  for (const d of legacy.distributions) {
    for (const a of d.allowlist ?? []) {
      if (a.phase === phase) {
        any = true;
        if (a.spots_airdrop > 0) {
          entries.push({
            wallet: d.wallet.toLowerCase(),
            amount: a.spots_airdrop
          });
        }
      }
    }
  }
  return any ? entries : null;
}

/**
 * Each phase. Phase membership is the legacy rows' (the allowlist
 * service's results are not public); the engine's rows, airdrop addresses and
 * counts are checked against the phase route, and its merged airdrops
 * against the distribution's airdrop spots for the phase.
 */
export function comparePhases(
  params: ParityParams,
  ctx: FinalListContext
): ParityReport[] {
  const rows = phasedRows(params, ctx);
  const phases = Array.from(
    new Set([
      ...Object.keys(params.legacy.phaseLists),
      ...rows.map((r) => r.phase).filter((p): p is string => !!p)
    ])
  ).sort(compareText);
  return phases.map((phase) => {
    const phaseRows = rows
      .filter((r) => r.phase === phase)
      .sort((a, b) => a.phasePosition - b.phasePosition);
    const newList = phaseRows.map((r) => ({
      wallet: r.airdropAddress ?? '',
      amount: r.subscribedCount
    }));
    const oldList = params.legacy.phaseLists[phase] ?? [];
    const diffs: ParityDiff[] = multisetDiff(oldList, newList).map((d) => ({
      key: null,
      wallet: d.wallet,
      field: 'phaseRow',
      old: d.old,
      new: d.new,
      cause: 'unknown'
    }));
    const orderDiffers = oldList.filter(
      (o, i) =>
        lower(o.wallet) !== lower(newList[i]?.wallet) ||
        o.amount !== newList[i]?.amount
    ).length;
    const notes: string[] = [];
    if (phase === 'Public') {
      notes.push(
        'the public phase airdrops 1 a row; the route shows the count'
      );
    } else {
      const sent = distributionAirdrops(params.legacy, phase);
      if (sent === null) {
        notes.push('no distribution airdrop spots for the phase');
      } else {
        for (const d of multisetDiff(sent, mergeDuplicateWallets(newList))) {
          diffs.push({
            key: null,
            wallet: d.wallet,
            field: 'airdropSent',
            old: d.old,
            new: d.new,
            cause: 'distribution-input'
          });
        }
      }
    }
    return {
      id: `${params.legacy.buildDate}/PHASE/${params.run}/${params.snapshot.tokenId}/${phase}`,
      gate: 'PHASE',
      run: params.run,
      card: params.snapshot.tokenId,
      phase,
      old: { rows: oldList.length, inputs: { source: 'phase route' } },
      new: { rows: newList.length, inputs: { membership: 'legacy rows' } },
      verdict: verdictOf(diffs),
      positionsDiffer: orderDiffers,
      diffs,
      notes
    };
  });
}

function balancesAtRedemption(
  params: ParityParams,
  ctx: FinalListContext,
  firstBlock: number
): Map<string, number> {
  const balances = new Map<string, number>();
  for (const row of ctx.build.rows) {
    const key = ctx.mapper.toIdentity(row.key);
    let balance = row.balance;
    const topUps = (params.legacy.topUps[row.key] ?? [])
      .filter((t) => t.block < firstBlock)
      .sort((a, b) => a.block - b.block);
    for (const t of topUps) {
      balance = roundSubscriptionBalance(balance + Number(t.amount));
    }
    balances.set(key, balance);
  }
  return balances;
}

/** The card's redemptions, engine against the legacy redeemed rows. */
export function compareRedemptions(
  params: ParityParams,
  ctx: FinalListContext
): ParityReport {
  const transfers = (params.transfers ?? params.legacy.airdropTransfers).filter(
    (t) => t.tokenId === params.snapshot.tokenId
  );
  const firstBlock = transfers.reduce(
    (m, t) => Math.min(m, t.block),
    Number.POSITIVE_INFINITY
  );
  const automatic = new Map(
    params.legacy.distributions.map((d) => [d.wallet.toLowerCase(), d.airdrops])
  );
  const result = matchRedemptions({
    transfers,
    afterBlock: Number.isFinite(firstBlock) ? firstBlock - 1 : 0,
    finalRows: phasedRows(params, ctx),
    balances: balancesAtRedemption(params, ctx, firstBlock),
    distributionAirdropCount: (wallet) => automatic.get(wallet) ?? 0
  });

  const entryKey = (key: string, tx: string, address: string) =>
    [key, tx.toLowerCase(), address.toLowerCase()].join('|');
  const oldEntries = new Map(
    params.legacy.redeemed.map((r) => [
      entryKey(
        ctx.mapper.toIdentity(r.consolidation_key),
        r.transaction,
        r.address
      ),
      r
    ])
  );
  const newEntries = new Map(
    result.redeemed.map((r) => [entryKey(r.key, r.transaction, r.address), r])
  );
  const toppedUp = new Set(
    Object.entries(params.legacy.topUps)
      .filter(([, list]) => list.length > 0)
      .map(([key]) => ctx.mapper.toIdentity(key))
  );
  const diffs: ParityDiff[] = [];
  const ids = Array.from(
    new Set([
      ...Array.from(oldEntries.keys()),
      ...Array.from(newEntries.keys())
    ])
  ).sort(compareText);
  for (const id of ids) {
    const [key, transaction] = id.split('|');
    const o = oldEntries.get(id);
    const n = newEntries.get(id);
    if (!o || !n) {
      diffs.push({
        key,
        transaction,
        field: 'redemption',
        old: o?.count ?? null,
        new: n?.count ?? null,
        cause: 'unknown'
      });
      continue;
    }
    if (Number(o.count) !== n.count) {
      diffs.push({
        key,
        transaction,
        field: 'count',
        old: o.count,
        new: n.count,
        cause: 'unknown'
      });
    }
    if (Number(o.balance_after) !== n.balanceAfter) {
      diffs.push({
        key,
        transaction,
        field: 'balanceAfter',
        old: o.balance_after,
        new: n.balanceAfter,
        cause: toppedUp.has(key) ? 'topup-timing' : 'balance-input'
      });
    }
  }
  const notes = [
    `transfers: ${transfers.length}, skipped: ${result.skipped.length}`,
    `no subscription found: ${result.notices.filter((n) => n.kind === 'NO_SUBSCRIPTION').length}`
  ];
  return {
    id: `${params.legacy.buildDate}/REDEMPTIONS/${params.run}/${params.snapshot.tokenId}`,
    gate: 'REDEMPTIONS',
    run: params.run,
    card: params.snapshot.tokenId,
    phase: null,
    old: { rows: oldEntries.size, inputs: { source: 'redeemed routes' } },
    new: {
      rows: newEntries.size,
      inputs: {
        transfers: params.transfers ? 'fixture' : 'transactions route'
      }
    },
    verdict: verdictOf(diffs),
    positionsDiffer: 0,
    diffs,
    notes
  };
}

/** All three gates for one run. */
export function runParity(params: ParityParams): ParityReport[] {
  const { report, context } = compareFinalList(params);
  const reports = [report, ...comparePhases(params, context)];
  if ((params.transfers ?? params.legacy.airdropTransfers).length > 0) {
    reports.push(compareRedemptions(params, context));
  }
  return reports;
}

export function summaryLine(report: ParityReport): string {
  const scope = report.phase
    ? `card ${report.card} ${report.phase}`
    : `card ${report.card}`;
  return `${report.gate} ${scope} ${report.run}: ${report.verdict} (old ${report.old.rows} rows, new ${report.new.rows} rows, ${report.diffs.length} diffs)`;
}
