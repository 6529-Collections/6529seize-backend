import { MEMES_CONTRACT, NULL_ADDRESS } from '@/constants';
import { AirdropTransfer } from '../engine/redemption';
import { compareText } from '../engine/text-order';
import { parseCsv } from './csv';
import {
  LegacyFinalRow,
  LegacyNormalizedDistribution,
  LegacyPhaseAirdrop,
  LegacyRedeemed,
  LegacySubscriptionsApi,
  LegacyTopUp,
  LegacyTransaction
} from './legacy-api';
import { toLogEntry } from './snapshot';
import {
  BuildLogDecision,
  parseBuildDecision,
  SubscriptionLogEntry
} from './subscription-logs';

export interface LegacyCsvRow {
  readonly key: string;
  readonly count: number;
  readonly airdropAddress: string | null;
  readonly balance: number;
  readonly subscribedAt: string;
}

/** What the legacy system published and recorded for one card. */
export interface LegacyOutputs {
  readonly version: 1;
  readonly contract: string;
  readonly tokenId: number;
  /** The build's date (YYYY-MM-DD) in its log lines. */
  readonly buildDate: string;
  readonly collectedFromMs: number;
  readonly collectedToMs: number;
  readonly csv: {
    readonly uploadUrl: string;
    readonly date: string;
    readonly rows: LegacyCsvRow[];
  } | null;
  /** The build's own line per key. */
  readonly buildDecisions: Record<string, BuildLogDecision>;
  /** Log lines per key since the snapshot, newest first. */
  readonly logs: Record<string, SubscriptionLogEntry[]>;
  readonly finalRows: Record<string, LegacyFinalRow>;
  readonly phaseLists: Record<string, LegacyPhaseAirdrop[]>;
  readonly distributions: LegacyNormalizedDistribution[];
  readonly redeemed: LegacyRedeemed[];
  /** Top-ups per key since the build, newest first. */
  readonly topUps: Record<string, LegacyTopUp[]>;
  readonly airdropTransfers: AirdropTransfer[];
  readonly cardCount: number | null;
}

export function toCsvRows(text: string, tokenId: number): LegacyCsvRow[] {
  return parseCsv(text)
    .filter((row) => Number(row.token_id) === tokenId)
    .map((row) => ({
      key: row.consolidation_key.toLowerCase(),
      count: Number(row.count),
      airdropAddress:
        row.airdrop_address && row.airdrop_address !== 'null'
          ? row.airdrop_address.toLowerCase()
          : null,
      balance: Number(row.balance),
      subscribedAt: row.subscribed_at
    }));
}

export function toAirdropTransfers(
  transactions: readonly LegacyTransaction[]
): AirdropTransfer[] {
  return transactions
    .filter(
      (t) =>
        t.from_address.toLowerCase() === NULL_ADDRESS &&
        Number(t.value) === 0 &&
        Number(t.token_count) > 0
    )
    .map((t) => ({
      transaction: t.transaction,
      block: Number(t.block),
      transactionDate: t.transaction_date,
      to: t.to_address.toLowerCase(),
      contract: t.contract,
      tokenId: Number(t.token_id),
      tokenCount: Number(t.token_count)
    }));
}

function latestDecision(
  logs: readonly SubscriptionLogEntry[],
  tokenId: number,
  buildDate: string
): BuildLogDecision | null {
  for (const entry of logs) {
    const decision = parseBuildDecision(entry, tokenId, buildDate);
    if (decision) {
      return decision;
    }
  }
  return null;
}

/**
 * Reads the legacy outputs for a card after its build (and, for the
 * redemption check, after its airdrop): the published list, each key's
 * build line and final row, the phase lists, the distribution, the
 * redemptions, top-ups since the build and the airdrop mints.
 */
export async function collectLegacyOutputs(
  api: LegacySubscriptionsApi,
  params: {
    readonly contract?: string;
    readonly tokenId: number;
    readonly buildDate: string;
    readonly keys: readonly string[];
    /** Read log lines back to here (the snapshot's start). */
    readonly logsSinceMs: number;
    /** Read top-ups and redemptions back to here (the build). */
    readonly buildAtMs: number;
    readonly now?: () => number;
    readonly onProgress?: (done: number, total: number) => void;
  }
): Promise<LegacyOutputs> {
  const now = params.now ?? (() => Date.now());
  const contract = params.contract ?? MEMES_CONTRACT;
  const collectedFromMs = now();

  const uploads = await api.uploads(contract, 2);
  const upload = uploads.find((u) => Number(u.token_id) === params.tokenId);
  const csv = upload
    ? {
        uploadUrl: upload.upload_url,
        date: upload.date,
        rows: toCsvRows(await api.fileText(upload.upload_url), params.tokenId)
      }
    : null;

  const keys = Array.from(
    new Set([
      ...params.keys.map((k) => k.toLowerCase()),
      ...(csv?.rows.map((r) => r.key) ?? [])
    ])
  ).sort(compareText);
  const onList = new Set(csv?.rows.map((r) => r.key) ?? []);

  const buildDecisions: Record<string, BuildLogDecision> = {};
  const logs: Record<string, SubscriptionLogEntry[]> = {};
  const finalRows: Record<string, LegacyFinalRow> = {};
  const topUps: Record<string, LegacyTopUp[]> = {};
  const redeemed: LegacyRedeemed[] = [];
  let done = 0;
  for (const key of keys) {
    const keyLogs = (await api.logs(key, params.logsSinceMs)).map(toLogEntry);
    logs[key] = keyLogs;
    const decision = latestDecision(keyLogs, params.tokenId, params.buildDate);
    if (decision) {
      buildDecisions[key] = decision;
    }
    if (onList.has(key) || decision?.kind === 'ADDED') {
      const row = await api.finalRow(key, contract, params.tokenId);
      if (row) {
        finalRows[key] = row;
      }
      topUps[key] = (await api.topUps(key, params.buildAtMs)).filter(
        (t) => Date.parse(t.transaction_date) >= params.buildAtMs
      );
      redeemed.push(
        ...(await api.redeemed(key, params.buildAtMs)).filter(
          (r) => Number(r.token_id) === params.tokenId
        )
      );
    }
    params.onProgress?.(++done, keys.length);
  }

  const phaseNames = new Set<string>(
    Object.values(finalRows)
      .map((r) => r.phase)
      .filter((p): p is string => !!p)
  );
  const phaseLists: Record<string, LegacyPhaseAirdrop[]> = {};
  for (const phase of Array.from(phaseNames).sort(compareText)) {
    phaseLists[phase] = await api.phaseList(contract, params.tokenId, phase);
  }

  return {
    version: 1,
    contract,
    tokenId: params.tokenId,
    buildDate: params.buildDate,
    collectedFromMs,
    collectedToMs: now(),
    csv,
    buildDecisions,
    logs,
    finalRows,
    phaseLists,
    distributions: await api.distributions(contract, params.tokenId),
    redeemed,
    topUps,
    airdropTransfers: toAirdropTransfers(
      await api.airdropTransactions(contract, params.tokenId)
    ),
    cardCount: await api.cardCount(params.tokenId)
  };
}
