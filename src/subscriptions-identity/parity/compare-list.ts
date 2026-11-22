import {
  buildFinalList,
  FinalListBuild,
  FinalListDecision,
  FinalListRow
} from '../engine/final-list';
import { compareText } from '../engine/text-order';
import { LegacyCsvRow } from './legacy-outputs';
import { EngineInputs, engineInputs, ParityParams } from './parity-inputs';
import {
  DiffCause,
  groupRows,
  ParityDiff,
  ParityReport,
  verdictOf
} from './parity-report';
import { InputNote } from './snapshot';

const TOPUP_TIMING_WINDOW_MS = 10 * 60 * 1000;

export interface ListComparison {
  readonly report: ParityReport;
  readonly build: FinalListBuild;
  readonly inputs: EngineInputs;
  readonly listRows: LegacyCsvRow[];
}

/**
 * Published list keys whose subscription moved to another key after the
 * build: a consolidation change moves the rows and log lines to the new key,
 * but the published file keeps the old one. A list key with no build line of
 * its own maps to the one read key that holds all of its wallets and has the
 * build's ADDED line, unless that key has a list row of its own or a second
 * list key would map to it too.
 */
export function rekeyedAfterBuild(
  listKeys: readonly string[],
  readKeys: readonly string[],
  added: ReadonlySet<string>
): Map<string, string> {
  const onList = new Set(listKeys);
  const candidates = new Map<string, string>();
  const claimed = new Map<string, number>();
  for (const key of listKeys) {
    if (added.has(key)) {
      continue;
    }
    const wallets = key.split('-');
    const holders = readKeys.filter((candidate) => {
      if (candidate === key || !added.has(candidate) || onList.has(candidate)) {
        return false;
      }
      const held = new Set(candidate.split('-'));
      return wallets.every((w) => held.has(w));
    });
    if (holders.length === 1) {
      candidates.set(key, holders[0]);
      claimed.set(holders[0], (claimed.get(holders[0]) ?? 0) + 1);
    }
  }
  return new Map(
    Array.from(candidates.entries()).filter(
      ([, holder]) => claimed.get(holder) === 1
    )
  );
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

function decisionsByIdentity(
  build: FinalListBuild,
  inputs: EngineInputs
): Map<string, FinalListDecision> {
  return new Map(
    build.decisions.map((d) => [inputs.mapper.toIdentity(d.key), d])
  );
}

function notesByIdentity(inputs: EngineInputs): Map<string, InputNote[]> {
  return new Map(
    Array.from(inputs.build.notes.entries()).map(([key, notes]) => [
      inputs.mapper.toIdentity(key),
      notes
    ])
  );
}

class Causes {
  private readonly decisions: Map<string, FinalListDecision>;
  private readonly notes: Map<string, InputNote[]>;
  private readonly collected: Set<string>;

  constructor(
    private readonly params: ParityParams,
    private readonly build: FinalListBuild,
    private readonly inputs: EngineInputs
  ) {
    this.decisions = decisionsByIdentity(build, inputs);
    this.notes = notesByIdentity(inputs);
    this.collected = new Set(
      params.snapshot.subscribers.map((s) => inputs.mapper.toIdentity(s.key))
    );
  }

  missingNew(key: string): DiffCause {
    if (!this.collected.has(key)) {
      return 'key-not-collected';
    }
    const decision = this.decisions.get(key);
    if (!decision) {
      return 'card-input';
    }
    if (
      decision.kind === 'NO_BALANCE' ||
      decision.kind === 'INSUFFICIENT_BALANCE'
    ) {
      return this.nearBuildTopUp(key) ? 'topup-timing' : 'balance-input';
    }
    return 'unknown';
  }

  extraNew(key: string, oldDecision: FinalListDecision['kind'] | null) {
    if (
      oldDecision === 'INSUFFICIENT_BALANCE' ||
      oldDecision === 'NO_BALANCE'
    ) {
      return this.nearBuildTopUp(key) ? 'topup-timing' : 'balance-input';
    }
    return 'card-input';
  }

  count(key: string): DiffCause {
    const notes = this.notes.get(key) ?? [];
    if (
      notes.includes('ROW_FLAG_AMBIGUOUS') ||
      notes.includes('ROW_FLAG_UNKNOWN')
    ) {
      return 'row-flag';
    }
    const decision = this.decisions.get(key);
    if (
      decision?.kind === 'ADDED' &&
      decision.count === decision.eligibility &&
      decision.eligibility < Math.min(decision.requested, decision.affordable)
    ) {
      return 'eligibility-input';
    }
    if (decision?.kind === 'ADDED' && decision.count === decision.affordable) {
      return this.nearBuildTopUp(key) ? 'topup-timing' : 'balance-input';
    }
    return 'unknown';
  }

  balance(key: string): DiffCause {
    return this.nearBuildTopUp(key) ? 'topup-timing' : 'balance-input';
  }

  airdrop(key: string): DiffCause {
    if (this.inputs.missingWallets.has(key)) {
      return 'no-wallets';
    }
    if (this.params.run === 'run1') {
      return 'airdrop-input';
    }
    const ties = this.inputs.ties.get(key) ?? [];
    if (ties.includes('TDH')) {
      return 'tdh-tie';
    }
    if (ties.length) {
      return 'delegation-tie';
    }
    return 'chain-source';
  }

  private nearBuildTopUp(key: string): boolean {
    for (const [legacyKey, topUps] of Object.entries(
      this.params.legacy.topUps
    )) {
      if (this.inputs.mapper.toIdentity(legacyKey) !== key) {
        continue;
      }
      if (
        topUps.some(
          (t) =>
            Math.abs(Date.parse(t.transaction_date) - this.params.buildAtMs) <=
            TOPUP_TIMING_WINDOW_MS
        )
      ) {
        return true;
      }
    }
    return false;
  }
}

function compareRow(
  key: string,
  o: LegacyCsvRow,
  n: FinalListRow,
  inputs: EngineInputs,
  causes: Causes
): ParityDiff[] {
  const diffs: ParityDiff[] = [];
  if (o.count !== n.subscribedCount) {
    diffs.push({
      key,
      field: 'count',
      old: o.count,
      new: n.subscribedCount,
      cause: causes.count(key)
    });
  }
  if (inputs.balanceChecked && o.balance !== n.balance) {
    diffs.push({
      key,
      field: 'balance',
      old: o.balance,
      new: n.balance,
      cause: causes.balance(key)
    });
  }
  if (
    inputs.airdropChecked &&
    (o.airdropAddress ?? '').toLowerCase() !==
      (n.airdropAddress ?? '').toLowerCase()
  ) {
    diffs.push({
      key,
      field: 'airdropAddress',
      old: o.airdropAddress,
      new: n.airdropAddress,
      cause: causes.airdrop(key)
    });
  }
  return diffs;
}

function checkedFields(inputs: EngineInputs): {
  checked: string[];
  notChecked: string[];
} {
  const checked = ['rows', 'count', 'cards'];
  const notChecked: string[] = [];
  if (inputs.balanceChecked) {
    checked.push('balance');
  } else {
    notChecked.push(`balance (copied from ${inputs.balanceSource})`);
  }
  if (inputs.airdropChecked) {
    checked.push('airdropAddress');
  } else {
    notChecked.push(`airdropAddress (copied from ${inputs.airdropSource})`);
  }
  notChecked.push('order (subscribed_at; positions reported)');
  return { checked, notChecked };
}

/**
 * The card's final list, the engine against the published list. Rows
 * are compared as lists: an identity with more than one row on either side
 * is a difference, and the total card count is part of the verdict.
 */
export function compareFinalList(params: ParityParams): ListComparison {
  const list = listRows(params);
  const inputs = engineInputs(params, list.rows);
  const build = buildFinalList({
    contract: params.snapshot.contract,
    tokenId: params.snapshot.tokenId,
    buildAtMs: params.buildAtMs,
    subscribers: inputs.build.inputs,
    resolveAirdrop: inputs.resolveAirdrop
  });
  const causes = new Causes(params, build, inputs);
  const toIdentity = (key: string) => inputs.mapper.toIdentity(key);
  const oldGroups = groupRows(list.rows, (r) => toIdentity(r.key));
  const newGroups = groupRows(build.rows, (r) => toIdentity(r.key));
  const oldDecisions = new Map(
    Object.entries(params.legacy.buildDecisions).map(([k, d]) => [
      toIdentity(k),
      d.kind
    ])
  );

  const diffs: ParityDiff[] = [];
  let positionsDiffer = 0;
  const keys = Array.from(
    new Set([...Array.from(oldGroups.keys()), ...Array.from(newGroups.keys())])
  ).sort(compareText);
  for (const key of keys) {
    const o = oldGroups.get(key) ?? [];
    const n = newGroups.get(key) ?? [];
    if (o.length > 1 || n.length > 1) {
      diffs.push({
        key,
        field: 'rows',
        old: o.length,
        new: n.length,
        cause: 'duplicate-identity'
      });
    } else if (o.length === 1 && n.length === 0) {
      diffs.push({
        key,
        field: 'row',
        old: o[0].count,
        new: null,
        cause: causes.missingNew(key)
      });
    } else if (o.length === 0 && n.length === 1) {
      const oldDecision = oldDecisions.get(key) ?? null;
      diffs.push({
        key,
        field: 'row',
        old: oldDecision,
        new: n[0].subscribedCount,
        cause: causes.extraNew(key, oldDecision)
      });
    } else if (o.length === 1 && n.length === 1) {
      diffs.push(...compareRow(key, o[0], n[0], inputs, causes));
      if (o[0].subscribedAt !== n[0].subscribedAt) {
        positionsDiffer++;
      }
    }
  }

  if (inputs.mode === 'gate' && inputs.readAfterBuild > 0) {
    diffs.push({
      key: null,
      field: 'keysReadAfterBuild',
      old: 0,
      new: inputs.readAfterBuild,
      cause: 'read-after-build'
    });
  }

  const oldCards = list.rows.reduce((sum, r) => sum + r.count, 0);
  const newCards = build.rows.reduce((sum, r) => sum + r.subscribedCount, 0);
  if (oldCards !== newCards) {
    diffs.push({
      key: null,
      field: 'cards',
      old: oldCards,
      new: newCards,
      cause: 'unknown'
    });
  }

  const notes = [...inputs.notes];
  if (
    params.legacy.cardCount !== null &&
    params.legacy.cardCount !== oldCards
  ) {
    notes.push(
      `the legacy count route (${params.legacy.cardCount}) differs from the published list (${oldCards})`
    );
  }
  if (!params.legacy.csv) {
    notes.push('no published list for the card');
  }
  if (list.rekeyed) {
    notes.push(`list keys re-keyed after the build: ${list.rekeyed}`);
  }
  const ambiguous = Array.from(inputs.build.notes.values()).filter((n) =>
    n.includes('ROW_FLAG_AMBIGUOUS')
  ).length;
  if (ambiguous) {
    notes.push(`row flag ambiguous for ${ambiguous} keys`);
  }
  if (inputs.ties.size) {
    notes.push(`ties left to the database's order: ${inputs.ties.size} keys`);
  }
  const fields = checkedFields(inputs);
  const report: ParityReport = {
    id: `${params.legacy.buildDate}/LIST/${params.run}/${inputs.mode}/${params.snapshot.tokenId}`,
    gate: 'LIST',
    run: params.run,
    mode: inputs.mode,
    card: params.snapshot.tokenId,
    phase: null,
    old: {
      rows: list.rows.length,
      cards: oldCards,
      inputs: {
        uploadUrl: params.legacy.csv?.uploadUrl ?? null,
        listDate: params.legacy.csv?.date ?? null
      }
    },
    new: {
      rows: build.rows.length,
      cards: newCards,
      inputs: {
        snapshotFrom: new Date(params.snapshot.collectedFromMs).toISOString(),
        snapshotTo: new Date(params.snapshot.collectedToMs).toISOString(),
        buildAt: new Date(params.buildAtMs).toISOString(),
        balances: inputs.balanceSource,
        airdrops: inputs.airdropSource
      }
    },
    checked: fields.checked,
    notChecked: fields.notChecked,
    verdict: verdictOf(diffs),
    positionsDiffer,
    diffs,
    notes
  };
  return { report, build, inputs, listRows: list.rows };
}
