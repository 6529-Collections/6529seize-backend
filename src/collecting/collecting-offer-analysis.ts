import {
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';
import { marketUintSchema } from '@/marketplace/seaport.schema';
import {
  OfferAnalysisRequest,
  OfferAnalysisRow,
  OfferAssetSignals,
  OfferAnalysisReason
} from '@/collecting/collecting-offer-analysis.types';

const BPS = BigInt(10000);
function unavailable(
  row: OfferAnalysisRow,
  reason: OfferAnalysisReason
): OfferAnalysisRow {
  return {
    ...row,
    status: 'UNAVAILABLE',
    reason_codes: [...row.reason_codes, reason]
  };
}
function formulaUnit(
  request: OfferAnalysisRequest,
  signals: OfferAssetSignals,
  base: bigint,
  row: OfferAnalysisRow
): bigint | OfferAnalysisReason {
  switch (request.method.kind) {
    case 'match_bid':
      row.reason_codes.push('MATCH_BID');
      return base;
    case 'improve_bid':
      row.reason_codes.push('IMPROVE_BID');
      return (
        (base * (BPS + BigInt(request.method.basis_points!)) +
          BPS -
          BigInt(1)) /
        BPS
      );
    case 'discount_ask':
      row.reason_codes.push('DISCOUNT_ASK');
      return (base * (BPS - BigInt(request.method.basis_points!))) / BPS;
    case 'goal': {
      // Sparse unique works have no validated comparable-sales model. Three
      // distinct observed sellers are a limited-evidence ERC1155 opening gate,
      // not a claim of independent control or probability of acceptance.
      if (
        signals.standard !== 'ERC1155' ||
        signals.distinct_ask_makers < 3 ||
        !signals.coverage_complete
      )
        return 'INSUFFICIENT_GOAL_EVIDENCE';
      const opening = (base * BigInt(7000)) / BPS;
      row.reason_codes.push('GOAL_PATIENT_OPENING');
      return signals.distinct_bid_makers < 2
        ? (opening * BigInt(9500)) / BPS
        : opening;
    }
    default:
      return 'NO_APPLICABLE_BID';
  }
}

function observedUnit(
  request: OfferAnalysisRequest,
  signals: OfferAssetSignals,
  row: OfferAnalysisRow
): bigint | OfferAnalysisReason {
  const usesBid = ['match_bid', 'improve_bid'].includes(request.method.kind);
  const reference = usesBid ? signals.bid : signals.ask;
  if (!reference) {
    row.reason_codes.push(...signals.reason_codes);
    return usesBid ? 'NO_APPLICABLE_BID' : 'NO_APPLICABLE_ASK';
  }
  row.references.push(reference);
  row.reason_codes.push('OBSERVED_REFERENCE_ONLY');
  const unit = formulaUnit(
    request,
    signals,
    BigInt(reference.unit_amount_wei),
    row
  );
  if (typeof unit === 'bigint' && reference.currency === MARKET_ZERO_ADDRESS)
    row.reason_codes.push('ETH_ASK_WETH_COMPARISON');
  return unit;
}

function priceRow(
  request: OfferAnalysisRequest,
  input: OfferAnalysisRequest['assets'][number],
  signals?: OfferAssetSignals
): OfferAnalysisRow {
  const row: OfferAnalysisRow = {
    asset_key: input.asset_key.toLowerCase(),
    quantity: input.quantity,
    pinned: input.manual_unit_amount_wei !== undefined,
    status: 'PRICED',
    selected: false,
    references: [],
    reason_codes: []
  };
  if (!signals || (signals.standard === 'ERC721' && input.quantity !== '1'))
    return unavailable(row, 'UNSUPPORTED_ASSET');
  let unit: bigint | OfferAnalysisReason;
  if (input.manual_unit_amount_wei) {
    unit = BigInt(input.manual_unit_amount_wei);
    row.reason_codes.push('MANUAL_PRICE');
  } else unit = observedUnit(request, signals, row);
  if (typeof unit !== 'bigint') return unavailable(row, unit);
  const total = unit * BigInt(input.quantity);
  if (
    unit <= BigInt(0) ||
    !marketUintSchema.safeParse(total.toString()).success
  )
    return unavailable(row, 'AMOUNT_OVERFLOW');
  return {
    ...row,
    unit_amount_wei: unit.toString(),
    total_amount_wei: total.toString()
  };
}

function sumRows(rows: OfferAnalysisRow[]): bigint {
  return rows.reduce(
    (sum, row) => sum + BigInt(row.total_amount_wei ?? '0'),
    BigInt(0)
  );
}
function selectGoalRows(rows: OfferAnalysisRow[], capacity: bigint): boolean {
  const pins = rows.filter((row) => row.pinned);
  if (pins.some((row) => row.status !== 'PRICED') || sumRows(pins) > capacity)
    return false;
  let remaining = capacity - sumRows(pins);
  for (const row of pins) row.selected = true;
  const optional = rows
    .filter((row) => !row.pinned && row.status === 'PRICED')
    .sort((a, b) => {
      const left = BigInt(a.total_amount_wei!),
        right = BigInt(b.total_amount_wei!);
      if (left === right) return a.asset_key.localeCompare(b.asset_key);
      return left < right ? -1 : 1;
    });
  for (const row of optional) {
    const amount = BigInt(row.total_amount_wei!);
    if (amount <= remaining) {
      row.selected = true;
      remaining -= amount;
    }
  }
  return true;
}

function finishRow(
  row: OfferAnalysisRow,
  request: OfferAnalysisRequest,
  pinConflict: boolean,
  invalidPin: boolean,
  limitReason: OfferAnalysisReason
): void {
  if (pinConflict) row.selected = false;
  if (row.status !== 'PRICED') {
    if (pinConflict && row.pinned) {
      row.status = 'PIN_CONFLICT';
      row.reason_codes.push('PIN_CONFLICT');
    }
    return;
  }
  if (!row.selected) {
    row.status =
      pinConflict && (row.pinned || invalidPin)
        ? 'PIN_CONFLICT'
        : 'EXCLUDED_BUDGET';
    if (!invalidPin) row.reason_codes.push(limitReason);
    if (row.status === 'PIN_CONFLICT') row.reason_codes.push('PIN_CONFLICT');
    return;
  }
  row.prepare_request = {
    profile_id: request.profile_id,
    wallet: request.wallet.toLowerCase(),
    recipient: request.recipient.toLowerCase(),
    acknowledge_external_recipient: request.acknowledge_external_recipient,
    kind: 'OFFER',
    asset_key: row.asset_key,
    quantity: row.quantity,
    currency: MARKET_WETH,
    amount_wei: row.total_amount_wei!,
    expires_at: request.expires_at
  };
}

/** Price the chosen exact NFTs once. Never reserve funds or construct signatures. */
export function allocateCollectOffers(
  request: OfferAnalysisRequest,
  signals: Map<string, OfferAssetSignals>,
  availableWei: bigint
) {
  const rows = request.assets.map((asset) =>
    priceRow(request, asset, signals.get(asset.asset_key.toLowerCase()))
  );
  const budget =
    request.max_total_weth_wei === undefined
      ? availableWei
      : BigInt(request.max_total_weth_wei);
  const capacity = budget < availableWei ? budget : availableWei;
  const priced = rows.filter((row) => row.status === 'PRICED');
  const invalidPin = rows.some((row) => row.pinned && row.status !== 'PRICED');
  const pinConflict =
    request.method.kind === 'goal'
      ? !selectGoalRows(rows, capacity)
      : invalidPin || sumRows(priced) > capacity;
  if (request.method.kind !== 'goal' && !pinConflict)
    for (const row of priced) row.selected = true;
  const limitReason =
    request.max_total_weth_wei !== undefined && budget <= availableWei
      ? 'BUDGET_EXCEEDED'
      : 'INSUFFICIENT_WETH';
  rows.forEach((row) =>
    finishRow(row, request, pinConflict, invalidPin, limitReason)
  );
  const proposed = sumRows(rows.filter((row) => row.selected));
  return {
    rows,
    proposed_weth_wei: proposed.toString(),
    unallocated_weth_wei: (capacity - proposed).toString()
  };
}
