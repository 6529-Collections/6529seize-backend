import { MANIFOLD, NULL_ADDRESS, NULL_ADDRESS_DEAD } from '@/constants';
import {
  DAY_MS,
  PairDailySummary,
  SourceTransfer,
  WalletDailySummary
} from '@/wallet-transfer-analysis/types';

const EXCLUDED_ADDRESSES = new Set(
  [NULL_ADDRESS, NULL_ADDRESS_DEAD, MANIFOLD].map((it) => it.toLowerCase())
);

function safeQuantity(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Transfer quantity must be a nonnegative safe integer');
  }
  return parsed;
}

function addQuantity(left: number, right: number): number {
  return safeQuantity(left + right);
}

function sourceTimestamp(value: Date | string): number {
  // MySQL DATETIME strings represent UTC, even on workers in another timezone.
  let normalized = value;
  if (typeof value === 'string') {
    if (
      !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(
        value
      )
    ) {
      throw new Error('Transfer timestamp format is invalid');
    }
    normalized = value.replace(' ', 'T');
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) {
      normalized += 'Z';
    }
  }
  const timestamp = new Date(normalized).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('Transfer timestamp is invalid');
  }
  return timestamp;
}

function address(value: string): string {
  if (!/^0x[0-9a-f]{40}$/i.test(value)) {
    throw new Error('Transfer address is invalid');
  }
  return value.toLowerCase();
}

interface Episode {
  transaction: string;
  from: string;
  to: string;
  timestamp: number;
  quantity: number;
  paid: boolean;
}

function toEpisodes(rows: SourceTransfer[], contract: string): Episode[] {
  const episodes = new Map<string, Episode>();
  for (const row of rows) {
    if (row.contract.toLowerCase() !== contract) {
      throw new Error('Unexpected contract in analysis batch');
    }
    const from = address(row.from_address);
    const to = address(row.to_address);
    const quantity = safeQuantity(row.token_count);
    if (
      from === to ||
      EXCLUDED_ADDRESSES.has(from) ||
      EXCLUDED_ADDRESSES.has(to) ||
      quantity === 0
    ) {
      continue;
    }
    const value = Number(row.value);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Transfer payment value is invalid');
    }
    const timestamp = sourceTimestamp(row.transaction_date);
    const transaction = row.transaction.toLowerCase();
    const key = `${transaction}:${from}:${to}`;
    const existing = episodes.get(key);
    if (existing) {
      if (existing.timestamp !== timestamp) {
        throw new Error('One transaction has inconsistent timestamps');
      }
      existing.quantity = addQuantity(existing.quantity, quantity);
      existing.paid ||= value > 0;
    } else {
      episodes.set(key, {
        transaction,
        from,
        to,
        timestamp,
        quantity,
        paid: value > 0
      });
    }
  }
  // Any attributed payment makes the entire sender/recipient episode a sale;
  // zero-valued companion card rows must not count as independent free transfers.
  return Array.from(episodes.values()).filter((episode) => !episode.paid);
}

export function aggregateTransferBucket(
  rows: SourceTransfer[],
  contract: string,
  bucketStart: number
): { pairs: PairDailySummary[]; wallets: WalletDailySummary[] } {
  contract = address(contract);
  const pairs = new Map<string, PairDailySummary>();
  const wallets = new Map<string, WalletDailySummary>();
  const getWallet = (wallet: string, day: number) => {
    const key = `${day}:${wallet}`;
    let summary = wallets.get(key);
    if (!summary) {
      summary = {
        contract,
        bucket_start: bucketStart,
        day_start: day,
        wallet,
        outbound_count: 0,
        inbound_count: 0,
        outbound_token_count: 0,
        inbound_token_count: 0
      };
      wallets.set(key, summary);
    }
    return summary;
  };

  for (const episode of toEpisodes(rows, contract)) {
    const day = Math.floor(episode.timestamp / DAY_MS) * DAY_MS;
    const key = `${day}:${episode.from}:${episode.to}`;
    const existing = pairs.get(key);
    if (existing) {
      existing.transfer_count++;
      existing.token_count = addQuantity(
        existing.token_count,
        episode.quantity
      );
      existing.first_transfer_at = Math.min(
        existing.first_transfer_at,
        episode.timestamp
      );
      existing.last_transfer_at = Math.max(
        existing.last_transfer_at,
        episode.timestamp
      );
      if (episode.transaction < existing.sample_transaction) {
        existing.sample_transaction = episode.transaction;
      }
    } else {
      pairs.set(key, {
        contract,
        bucket_start: bucketStart,
        day_start: day,
        from_address: episode.from,
        to_address: episode.to,
        transfer_count: 1,
        token_count: episode.quantity,
        first_transfer_at: episode.timestamp,
        last_transfer_at: episode.timestamp,
        sample_transaction: episode.transaction
      });
    }
    const sender = getWallet(episode.from, day);
    sender.outbound_count++;
    sender.outbound_token_count = addQuantity(
      sender.outbound_token_count,
      episode.quantity
    );
    const receiver = getWallet(episode.to, day);
    receiver.inbound_count++;
    receiver.inbound_token_count = addQuantity(
      receiver.inbound_token_count,
      episode.quantity
    );
  }
  return {
    pairs: Array.from(pairs.values()),
    wallets: Array.from(wallets.values())
  };
}
