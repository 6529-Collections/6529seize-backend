import {
  DAY_MS,
  PairMetrics,
  TRANSFER_RULE_VERSION
} from '@/wallet-transfer-analysis/types';

/** Initial review-priority rules, not calibrated ownership probabilities. */
export const TRANSFER_RULES = Object.freeze({
  minimumEpisodes: 3,
  minimumActiveDays: 3,
  minimumSpanDays: 7,
  reciprocalMinimumEpisodesPerDirection: 2,
  reciprocalMinimumDaysPerDirection: 2,
  concentratedOutboundShare: 0.5
});

function share(count: number, total: number): number {
  return total > 0 ? Math.min(1, count / total) : 0;
}

export function scoreTransferPair(metrics: PairMetrics) {
  const outboundA = share(metrics.a_to_b_count, metrics.a_outbound_count);
  const outboundB = share(metrics.b_to_a_count, metrics.b_outbound_count);
  const concentration = Math.max(outboundA, outboundB);
  const episodes = metrics.a_to_b_count + metrics.b_to_a_count;
  const spanDays =
    (metrics.last_transfer_at - metrics.first_transfer_at) / DAY_MS;
  const repeated =
    episodes >= TRANSFER_RULES.minimumEpisodes &&
    metrics.active_days >= TRANSFER_RULES.minimumActiveDays &&
    spanDays >= TRANSFER_RULES.minimumSpanDays;
  const reciprocal =
    repeated &&
    metrics.a_to_b_count >=
      TRANSFER_RULES.reciprocalMinimumEpisodesPerDirection &&
    metrics.b_to_a_count >=
      TRANSFER_RULES.reciprocalMinimumEpisodesPerDirection &&
    metrics.a_to_b_days >= TRANSFER_RULES.reciprocalMinimumDaysPerDirection &&
    metrics.b_to_a_days >= TRANSFER_RULES.reciprocalMinimumDaysPerDirection;
  const concentrated =
    repeated && concentration >= TRANSFER_RULES.concentratedOutboundShare;
  const rules: string[] = [];
  if (reciprocal) rules.push('repeated_reciprocal_transfers');
  if (concentrated) rules.push('concentrated_outgoing_transfers');
  if (repeated) rules.push('persistent_transfer_relationship');

  const priority = repeated
    ? Math.round(
        Math.min(30, metrics.active_days * 3) +
          Math.min(20, (spanDays / 30) * 5) +
          (reciprocal ? 30 : 10) +
          concentration * 20
      )
    : 0;
  return {
    ...metrics,
    rule_version: TRANSFER_RULE_VERSION,
    priority_score: priority,
    rules,
    span_days: Math.floor(spanDays),
    a_to_b_outbound_share: outboundA,
    a_to_b_inbound_share: share(metrics.a_to_b_count, metrics.b_inbound_count),
    b_to_a_outbound_share: outboundB,
    b_to_a_inbound_share: share(metrics.b_to_a_count, metrics.a_inbound_count),
    explanation:
      `${metrics.a_to_b_count} A-to-B and ${metrics.b_to_a_count} B-to-A ` +
      `non-sale-classified transfer occasions on ${metrics.active_days} UTC days ` +
      `over ${Math.floor(spanDays)} days. ` +
      `These represent ${Math.round(outboundA * 100)}% of A's and ` +
      `${Math.round(outboundB * 100)}% of B's outgoing transfer occasions.`
  };
}

export function rankTransferPairs(metrics: PairMetrics[], limit: number) {
  return metrics
    .map(scoreTransferPair)
    .filter((it) => it.priority_score > 0)
    .sort(
      (a, b) =>
        b.priority_score - a.priority_score ||
        b.active_days - a.active_days ||
        a.wallet_a.localeCompare(b.wallet_a) ||
        a.wallet_b.localeCompare(b.wallet_b)
    )
    .slice(0, limit);
}
