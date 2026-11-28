import { roundSubscriptionBalance } from '../engine/parity-money';
import { matchRedemptions } from '../engine/redemption';
import { compareText } from '../engine/text-order';
import { ListComparison } from './compare-list';
import { phasedRows } from './compare-phases';
import { LegacyRedeemed } from './legacy-api';
import { ParityParams } from './parity-inputs';
import {
  groupRows,
  ParityDiff,
  ParityReport,
  verdictOf
} from './parity-report';

function balancesAtRedemption(
  params: ParityParams,
  list: ListComparison,
  firstBlock: number
): Map<string, number> {
  const balances = new Map<string, number>();
  for (const row of list.build.rows) {
    const key = list.inputs.mapper.toIdentity(row.key);
    let balance = row.balance;
    const topUps = (params.legacy.topUps[row.key] ?? [])
      .filter(
        (t) =>
          Date.parse(t.transaction_date) >= params.buildAtMs &&
          t.block < firstBlock
      )
      .sort((a, b) => a.block - b.block);
    for (const t of topUps) {
      balance = roundSubscriptionBalance(balance + Number(t.amount));
    }
    balances.set(key, balance);
  }
  return balances;
}

function entryId(key: string, transaction: string, address: string): string {
  return [key, transaction.toLowerCase(), address.toLowerCase()].join('|');
}

/** The card's redemptions, the engine against the legacy redeemed rows. */
export function compareRedemptions(
  params: ParityParams,
  list: ListComparison
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
    finalRows: phasedRows(params, list),
    balances: balancesAtRedemption(params, list, firstBlock),
    distributionAirdropCount: (wallet) => automatic.get(wallet) ?? 0
  });

  const toIdentity = (key: string) => list.inputs.mapper.toIdentity(key);
  const oldGroups = groupRows(params.legacy.redeemed, (r: LegacyRedeemed) =>
    entryId(toIdentity(r.consolidation_key), r.transaction, r.address)
  );
  const newGroups = groupRows(result.redeemed, (r) =>
    entryId(r.key, r.transaction, r.address)
  );
  const toppedUp = new Set(
    Object.entries(params.legacy.topUps)
      .filter(([, topUps]) =>
        topUps.some((t) => Date.parse(t.transaction_date) >= params.buildAtMs)
      )
      .map(([key]) => toIdentity(key))
  );
  const diffs: ParityDiff[] = [];
  const ids = Array.from(
    new Set([...Array.from(oldGroups.keys()), ...Array.from(newGroups.keys())])
  ).sort(compareText);
  for (const id of ids) {
    const [key, transaction] = id.split('|');
    const o = oldGroups.get(id) ?? [];
    const n = newGroups.get(id) ?? [];
    if (o.length !== 1 || n.length !== 1) {
      diffs.push({
        key,
        transaction,
        field:
          o.length > 1 || n.length > 1 ? 'duplicateRedemption' : 'redemption',
        old: o.map((r) => Number(r.count)),
        new: n.map((r) => r.count),
        cause: o.length > 1 || n.length > 1 ? 'duplicate-identity' : 'unknown'
      });
      continue;
    }
    if (Number(o[0].count) !== n[0].count) {
      diffs.push({
        key,
        transaction,
        field: 'count',
        old: Number(o[0].count),
        new: n[0].count,
        cause: 'unknown'
      });
    }
    if (
      list.inputs.balanceChecked &&
      Number(o[0].balance_after) !== n[0].balanceAfter
    ) {
      diffs.push({
        key,
        transaction,
        field: 'balanceAfter',
        old: Number(o[0].balance_after),
        new: n[0].balanceAfter,
        cause: toppedUp.has(key) ? 'topup-timing' : 'balance-input'
      });
    }
  }

  const checked = ['redemption', 'count'];
  const notChecked = [
    'phase membership (copied; it orders redemptions to a shared airdrop address)'
  ];
  if (!list.inputs.airdropChecked) {
    notChecked.push(
      'airdropAddress (copied in run 1; mints are matched to rows by it)'
    );
  }
  if (list.inputs.balanceChecked) {
    checked.push('balanceAfter');
  } else {
    notChecked.push(`balanceAfter (starts from ${list.inputs.balanceSource})`);
  }
  const noSubscription = result.notices.filter(
    (n) => n.kind === 'NO_SUBSCRIPTION'
  ).length;
  return {
    id: `${params.legacy.buildDate}/REDEMPTIONS/${params.run}/${list.inputs.mode}/${params.snapshot.tokenId}`,
    gate: 'REDEMPTIONS',
    run: params.run,
    mode: list.inputs.mode,
    card: params.snapshot.tokenId,
    phase: null,
    old: {
      rows: params.legacy.redeemed.length,
      inputs: { source: 'redeemed routes' }
    },
    new: {
      rows: result.redeemed.length,
      inputs: {
        transfers: params.transfers ? 'fixture' : 'transactions route'
      }
    },
    checked,
    notChecked,
    verdict: verdictOf(diffs),
    positionsDiffer: 0,
    diffs,
    notes: [
      `transfers: ${transfers.length}, skipped: ${result.skipped.length}`,
      `tokens with no subscription found: ${noSubscription}`
    ]
  };
}
