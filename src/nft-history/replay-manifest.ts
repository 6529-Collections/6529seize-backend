import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { Log } from '@/ethereum-rpc/ethereum-rpc-types';
import { decodeClaimUpdate, discoverClaimUpdates } from './claim-events';
import { HistorySnapshot, HistoryWritePlan, nftHistoryDb } from './history.db';
import { canonicalJson, historyDigest } from './canonical-json';
import { prepareHistoryWrite } from './processor';
import { MAX_REPLAY_EVENTS, ReplayRange } from './replay-request';

export interface ReplayEntry {
  log: Log;
  disposition:
    | 'insert-edit'
    | 'settings-only'
    | 'existing-event'
    | 'reconcile-legacy';
  plan: HistoryWritePlan;
}

export interface ReplayManifest {
  version: 1;
  range: ReplayRange;
  cutoffHash: string;
  windowEndHash: string;
  entries: ReplayEntry[];
  failures: {
    transaction_hash: string;
    log_index: number;
    block: number;
    extension: string;
    error: string;
  }[];
}

export function planReceipt(plan: HistoryWritePlan) {
  return {
    ...plan,
    inserts: plan.inserts.map(({ created_at: _createdAt, ...row }) => row)
  };
}

export function manifestDigest(manifest: ReplayManifest): string {
  return historyDigest({
    ...manifest,
    entries: manifest.entries.map((entry) => ({
      ...entry,
      plan: planReceipt(entry.plan)
    }))
  });
}

export function applyVirtualPlan(
  snapshot: HistorySnapshot,
  plan: HistoryWritePlan
): HistorySnapshot {
  return {
    legacy: snapshot.legacy.map((row) => {
      const update = plan.legacyUpdates.find(
        (change) =>
          change.uri === row.uri &&
          change.transaction_hash === row.transaction_hash
      );
      return update ? { ...row, description: update.description } : row;
    }),
    events: [
      ...snapshot.events.map((row) => {
        const update = plan.eventUpdates.find(
          (change) => change.event_id === row.event_id
        );
        return update ? { ...row, description: update.description } : row;
      }),
      ...plan.inserts
    ]
  };
}

export async function verifyReplayRange(
  range: ReplayRange,
  expected?: ReplayManifest
): Promise<{ cutoffHash: string; windowEndHash: string }> {
  const rpc = getEthereumRpcClient();
  const [finalized, cutoff, end] = await Promise.all([
    rpc.getBlock('finalized'),
    rpc.getBlock(range.cutoffBlock),
    rpc.getBlock(range.toBlock)
  ]);
  if (range.cutoffBlock > finalized.number || !cutoff.hash || !end.hash)
    throw new Error('Replay cutoff must be finalized');
  if (
    expected &&
    (cutoff.hash !== expected.cutoffHash || end.hash !== expected.windowEndHash)
  )
    throw new Error('Replay chain anchors changed; regenerate the audit');
  return { cutoffHash: cutoff.hash, windowEndHash: end.hash };
}

function classifyPlan(
  plan: HistoryWritePlan,
  snapshot: HistorySnapshot,
  hash: string
): ReplayEntry['disposition'] {
  if (!plan.inserts.length) return 'existing-event';
  if (
    snapshot.legacy.some(
      (row) => row.transaction_hash.toLowerCase() === hash.toLowerCase()
    )
  )
    return 'reconcile-legacy';
  return plan.inserts[0].description ? 'insert-edit' : 'settings-only';
}

export async function auditHistoryRange(
  range: ReplayRange,
  remainingMillis: () => number
): Promise<ReplayManifest> {
  const anchors = await verifyReplayRange(range);
  const logs = await discoverClaimUpdates(range.fromBlock, range.toBlock, true);
  if (logs.length > MAX_REPLAY_EVENTS)
    throw new Error('Replay window too dense; reduce its block range');
  const manifest: ReplayManifest = {
    version: 1,
    range,
    ...anchors,
    entries: [],
    failures: []
  };
  const snapshots = new Map<string, HistorySnapshot>();
  for (const log of logs) {
    if (remainingMillis() < 90000)
      throw new Error('Audit time budget exhausted; reduce its block range');
    try {
      const event = await decodeClaimUpdate(log, (contract, id) =>
        nftHistoryDb.resolveClaim(contract, id)
      );
      const key = `${event.contract.toLowerCase()}:${event.nft_id}`;
      const snapshot =
        snapshots.get(key) ??
        (await nftHistoryDb.snapshot(event.contract, event.nft_id));
      const plan = await prepareHistoryWrite(event, snapshot);
      const disposition = classifyPlan(plan, snapshot, event.transaction_hash);
      manifest.entries.push({ log, plan, disposition });
      snapshots.set(key, applyVirtualPlan(snapshot, plan));
    } catch (error) {
      manifest.failures.push({
        transaction_hash: log.transactionHash,
        log_index: log.logIndex,
        block: log.blockNumber,
        extension: log.address,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  await verifyReplayRange(range, manifest);
  if (Buffer.byteLength(canonicalJson(manifest)) > 2_000_000)
    throw new Error('Replay manifest too large; reduce its block range');
  return manifest;
}
