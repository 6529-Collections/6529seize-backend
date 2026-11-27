import { compareText } from '../engine/text-order';
import { LegacySubscriptionsApi } from './legacy-api';

/**
 * The legacy top-up loop posts each top-up in the subscriptions wave as
 * "Subscription Top Up of <amount> ETH from <wallet>." This reads the
 * sender, or null for any other drop.
 */
export function parseTopUpSender(content: string | null): string | null {
  const m = /Subscription Top Up of \S+ ETH from (0x[0-9a-fA-F]{40})\b/.exec(
    content ?? ''
  );
  return m ? m[1].toLowerCase() : null;
}

/**
 * The consolidation keys of everyone who topped up since `sinceMs`, from the
 * subscriptions wave's top-up drops, each sender resolved to its identity's
 * key (a wallet with no identity is its own key). These are subscribers who
 * may be on no recent published list; pass them to `keys --keys-file`.
 */
export async function collectTopUpSenderKeys(
  api: LegacySubscriptionsApi,
  params: { readonly waveId: string; readonly sinceMs: number }
): Promise<string[]> {
  const senders = new Set<string>();
  let before: number | undefined;
  for (;;) {
    const drops = await api.waveDrops(params.waveId, before);
    if (drops.length === 0) {
      break;
    }
    for (const drop of drops) {
      if (drop.created_at < params.sinceMs) {
        continue;
      }
      for (const part of drop.parts) {
        const sender = parseTopUpSender(part.content);
        if (sender) {
          senders.add(sender);
        }
      }
    }
    const oldest = drops.reduce((m, d) => Math.min(m, d.serial_no), Infinity);
    const oldestAt = drops.reduce(
      (m, d) => Math.min(m, d.created_at),
      Infinity
    );
    if (oldestAt < params.sinceMs || !Number.isFinite(oldest)) {
      break;
    }
    before = oldest;
  }
  const keys = new Set<string>();
  for (const sender of Array.from(senders).sort(compareText)) {
    const identity = await api.identityByWallet(sender);
    keys.add((identity?.consolidation_key ?? sender).toLowerCase());
  }
  return Array.from(keys).sort(compareText);
}
