import { mergeDuplicateWallets } from '@/api/api-wallet-helpers';
import {
  applyKnownPhases,
  PhasedFinalRow,
  toPhasedRow,
  WalletAmount
} from '../engine/phase-split';
import { compareText } from '../engine/text-order';
import { ListComparison } from './compare-list';
import { LegacyOutputs } from './legacy-outputs';
import { ParityParams } from './parity-inputs';
import { ParityDiff, ParityReport, verdictOf } from './parity-report';

const PUBLIC_PHASE = 'Public';

/**
 * The engine's rows for the card, with phase membership copied from the
 * legacy rows: the allowlist service's phase results are not public, so the
 * public-data run cannot run the split itself.
 */
export function phasedRows(
  params: ParityParams,
  list: ListComparison
): PhasedFinalRow[] {
  const phaseByKey = new Map<string, string>();
  for (const [key, row] of Object.entries(params.legacy.finalRows)) {
    if (row.phase) {
      phaseByKey.set(list.inputs.mapper.toIdentity(key), row.phase);
    }
  }
  const rows = list.build.rows.map((r) =>
    toPhasedRow({ ...r, key: list.inputs.mapper.toIdentity(r.key) })
  );
  return applyKnownPhases(rows, phaseByKey);
}

function multisetDiff(
  oldList: readonly WalletAmount[],
  newList: readonly WalletAmount[]
): Array<{ wallet: string; old: number[]; new: number[] }> {
  const byWallet = (list: readonly WalletAmount[]) => {
    const m = new Map<string, number[]>();
    for (const e of list) {
      const w = e.wallet.toLowerCase();
      m.set(w, [...(m.get(w) ?? []), e.amount]);
    }
    return m;
  };
  const o = byWallet(oldList);
  const n = byWallet(newList);
  const wallets = Array.from(
    new Set([...Array.from(o.keys()), ...Array.from(n.keys())])
  ).sort(compareText);
  const out: Array<{ wallet: string; old: number[]; new: number[] }> = [];
  for (const wallet of wallets) {
    const oa = (o.get(wallet) ?? []).slice().sort((a, b) => a - b);
    const na = (n.get(wallet) ?? []).slice().sort((a, b) => a - b);
    if (oa.join(',') !== na.join(',')) {
      out.push({ wallet, old: oa, new: na });
    }
  }
  return out;
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

function phaseReport(
  params: ParityParams,
  list: ListComparison,
  rows: readonly PhasedFinalRow[],
  phase: string
): ParityReport {
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
  const checked = ['phaseRow (airdrop address and count of each member)'];
  const notChecked = [
    'membership (copied from the legacy rows; the phase inputs are not public)',
    'order (phase positions reported)'
  ];
  if (!list.inputs.airdropChecked) {
    notChecked.push(
      `airdropAddress (copied from ${list.inputs.airdropSource}; counts are compared per address)`
    );
  }
  const notes: string[] = [];
  if (phase === PUBLIC_PHASE) {
    notChecked.push(
      'sent amount (the public phase sends 1 a row; the route shows the count; the redemption comparison checks the mints)'
    );
  } else {
    const sent = distributionAirdrops(params.legacy, phase);
    if (sent === null) {
      notes.push('no distribution airdrop spots for the phase');
      notChecked.push('airdropSent (no distribution spots published)');
    } else {
      checked.push('airdropSent (merged airdrops against distribution spots)');
      for (const d of multisetDiff(sent, mergeDuplicateWallets(newList))) {
        diffs.push({
          key: null,
          wallet: d.wallet,
          field: 'airdropSent',
          old: d.old,
          new: d.new,
          cause: 'unknown'
        });
      }
    }
  }
  const orderDiffers = oldList.filter(
    (o, i) =>
      o.wallet.toLowerCase() !== (newList[i]?.wallet ?? '').toLowerCase() ||
      o.amount !== newList[i]?.amount
  ).length;
  return {
    id: `${params.legacy.buildDate}/PHASE/${params.run}/${list.inputs.mode}/${params.snapshot.tokenId}/${phase}`,
    gate: 'PHASE',
    run: params.run,
    mode: list.inputs.mode,
    card: params.snapshot.tokenId,
    phase,
    old: { rows: oldList.length, inputs: { source: 'phase route' } },
    new: { rows: newList.length, inputs: { membership: 'legacy rows' } },
    checked,
    notChecked,
    verdict: verdictOf(diffs),
    positionsDiffer: orderDiffers,
    diffs,
    notes
  };
}

/**
 * Each phase. Membership is copied, so this does not test the split;
 * it tests each member row's airdrop address and count against the phase
 * route, and the merged airdrops against the distribution's airdrop spots.
 */
export function comparePhases(
  params: ParityParams,
  list: ListComparison
): ParityReport[] {
  const rows = phasedRows(params, list);
  const phases = Array.from(
    new Set([
      ...Object.keys(params.legacy.phaseLists),
      ...rows.map((r) => r.phase).filter((p): p is string => !!p)
    ])
  ).sort(compareText);
  return phases.map((phase) => phaseReport(params, list, rows, phase));
}
