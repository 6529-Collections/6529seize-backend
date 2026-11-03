import { Logger } from '@/logging';
import { canonicalJson, historyDigest } from './canonical-json';
import {
  HistoryTransaction,
  discoverHistoryTransactions
} from './history-transactions';
import { decodeHistorySource } from './source-operations';
import {
  HistorySourcePlan,
  SourceReader,
  VirtualSourceReader,
  hasMint,
  prepareSourcePlan,
  sourcePlanReceipt
} from './source-plan';
import { historySourceDb } from './source.db';
import { nftHistoryReplayDb } from './replay.db';
import {
  MAX_REPLAY_EVENTS,
  ReplayRange,
  parseReplayRequest
} from './replay-request';
import { verifyReplayRange } from './replay-manifest';

export type SourceReplayRequest = ReplayRange &
  (
    | { mode: 'nft-history-source-replay'; action: 'dry-run' }
    | {
        mode: 'nft-history-source-replay';
        action: 'apply';
        jobId: string;
        approvalDigest: string;
      }
  );
interface SourceRange extends ReplayRange {
  mode: 'nft-history-source-replay';
}
interface SourceManifest {
  version: 2;
  range: SourceRange;
  cutoffHash: string;
  windowEndHash: string;
  entries: { source: HistoryTransaction; plan: HistorySourcePlan }[];
  failures: { transaction_hash: string; block: number; error: string }[];
}

interface SourceAuditResult {
  manifest: SourceManifest;
  approvalDigest: string;
  applicable: boolean;
}
interface SourceApplyResult {
  jobId: string;
  approvalDigest: string;
  nextIndex: number;
  totalEntries: number;
  complete: boolean;
  nextFromBlock: number | null;
}

export function parseSourceReplayRequest(
  event: unknown
): SourceReplayRequest | null {
  if (
    !event ||
    typeof event !== 'object' ||
    (event as Record<string, unknown>).mode !== 'nft-history-source-replay'
  )
    return null;
  // Identical strict bounds, scheduling rejection and approval identity rules.
  const parsed = parseReplayRequest({ ...event, mode: 'nft-history-replay' })!;
  return { ...parsed, mode: 'nft-history-source-replay' };
}

function sourceRange(request: SourceReplayRequest): SourceRange {
  return {
    mode: 'nft-history-source-replay',
    fromBlock: request.fromBlock,
    toBlock: request.toBlock,
    cutoffBlock: request.cutoffBlock
  };
}

export function sourceManifestDigest(manifest: SourceManifest): string {
  return historyDigest({
    ...manifest,
    entries: manifest.entries.map((entry) => ({
      source: entry.source,
      plan: sourcePlanReceipt(entry.plan)
    }))
  });
}

export async function prepareTransactionSource(
  source: HistoryTransaction,
  reader: SourceReader,
  remainingMillis: () => number = () => 900000,
  recordInitialization = false
): Promise<HistorySourcePlan> {
  const operations = await decodeHistorySource(source, {
    hasMint: async (contract, id) =>
      hasMint(await reader.history(contract, id)),
    remainingMillis,
    recordInitialization
  });
  return prepareSourcePlan(operations, reader, remainingMillis);
}

export async function auditHistorySources(
  range: SourceRange,
  remainingMillis: () => number
): Promise<SourceManifest> {
  const anchors = await verifyReplayRange(range);
  const sources = await discoverHistoryTransactions(
    range.fromBlock,
    range.toBlock,
    true,
    remainingMillis
  );
  const manifest: SourceManifest = {
    version: 2,
    range,
    ...anchors,
    entries: [],
    failures: []
  };
  const view = new VirtualSourceReader(historySourceDb);
  for (const source of sources) {
    if (remainingMillis() < 90000)
      throw new Error(
        'Source audit time budget exhausted; reduce its block range'
      );
    try {
      const plan = await prepareTransactionSource(
        source,
        view,
        remainingMillis
      );
      if (plan.claims.length || plan.writes.length) {
        manifest.entries.push({ source, plan });
        await view.apply(plan);
      }
    } catch (error) {
      manifest.failures.push({
        transaction_hash: source.hash,
        block: source.block,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (manifest.entries.length + manifest.failures.length > MAX_REPLAY_EVENTS)
      throw new Error('Source replay window too dense; reduce its block range');
  }
  await verifySourceAnchors(manifest);
  if (Buffer.byteLength(canonicalJson(manifest)) > 2_000_000)
    throw new Error('Source replay manifest too large; reduce its block range');
  return manifest;
}

async function verifySourceAnchors(manifest: SourceManifest): Promise<void> {
  const current = await verifyReplayRange(manifest.range);
  if (
    current.cutoffHash !== manifest.cutoffHash ||
    current.windowEndHash !== manifest.windowEndHash
  )
    throw new Error(
      'Source replay chain anchors changed; review a fresh audit'
    );
}

export async function runSourceReplay(
  request: SourceReplayRequest,
  remainingMillis: () => number
): Promise<SourceAuditResult | SourceApplyResult> {
  const range = sourceRange(request);
  if (request.action === 'dry-run') {
    const manifest = await auditHistorySources(range, remainingMillis);
    return {
      manifest,
      approvalDigest: sourceManifestDigest(manifest),
      applicable: manifest.failures.length === 0
    };
  }
  if (process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED !== 'true')
    throw new Error(
      'Replay apply is disabled; separate execution approval is required'
    );
  const job = await loadSourceJob(request, remainingMillis);
  const manifest = parseSourceManifest(job, request);
  await verifySourceAnchors(manifest);
  let index = job.next_index;
  while (index < manifest.entries.length && remainingMillis() >= 90000) {
    const expected = manifest.entries[index];
    const plan = await prepareTransactionSource(
      expected.source,
      historySourceDb,
      remainingMillis
    );
    if (
      canonicalJson(sourcePlanReceipt(plan)) !==
      canonicalJson(sourcePlanReceipt(expected.plan))
    )
      throw new Error(
        'Source history, claim mapping or metadata changed since approval'
      );
    await historySourceDb.apply(plan, (manager) =>
      nftHistoryReplayDb.advance(manager, request.jobId, index)
    );
    index++;
  }
  const complete = index === manifest.entries.length;
  return {
    jobId: request.jobId,
    approvalDigest: request.approvalDigest,
    nextIndex: index,
    totalEntries: manifest.entries.length,
    complete,
    nextFromBlock:
      complete && request.toBlock < request.cutoffBlock
        ? request.toBlock + 1
        : null
  };
}

async function loadSourceJob(
  request: Extract<SourceReplayRequest, { action: 'apply' }>,
  remainingMillis: () => number
) {
  const range = sourceRange(request);
  let job = await nftHistoryReplayDb.find(request.jobId);
  if (!job) {
    const manifest = await auditHistorySources(range, remainingMillis);
    if (
      manifest.failures.length ||
      sourceManifestDigest(manifest) !== request.approvalDigest
    )
      throw new Error(
        'Source audit blocked or changed since approval; review a fresh dry-run'
      );
    job = await nftHistoryReplayDb.create(
      request.jobId,
      request.approvalDigest,
      range,
      manifest
    );
  }
  return job;
}

function parseSourceManifest(
  job: import('@/entities/INFTHistoryReplayJob').NFTHistoryReplayJobEntity,
  request: Extract<SourceReplayRequest, { action: 'apply' }>
): SourceManifest {
  const range = sourceRange(request);
  let manifest: SourceManifest;
  try {
    manifest = JSON.parse(job.manifest_json) as SourceManifest;
    if (
      job.request_json !== canonicalJson(range) ||
      job.digest !== request.approvalDigest ||
      manifest.version !== 2 ||
      canonicalJson(manifest.range) !== job.request_json ||
      manifest.failures.length ||
      sourceManifestDigest(manifest) !== job.digest ||
      !Number.isSafeInteger(job.next_index) ||
      job.next_index < 0 ||
      job.next_index > manifest.entries.length
    )
      throw new Error('Invalid source replay receipt');
  } catch {
    throw new Error('Invalid or differently scoped source replay receipt');
  }
  return manifest;
}

// Keep discovery itself small enough to finish before processing/checkpointing.
export const HISTORY_DISCOVERY_BLOCKS = 20;

/** Normal ingestion shares the replay decoder without replay's job/checkpoint. */
export async function ingestHistorySources(
  fromBlock: number,
  toBlock: number,
  remainingMillis: () => number,
  checkpoint: (block: number) => Promise<void>
): Promise<void> {
  for (
    let from = fromBlock;
    from <= toBlock;
    from += HISTORY_DISCOVERY_BLOCKS
  ) {
    const end = Math.min(from + HISTORY_DISCOVERY_BLOCKS - 1, toBlock);
    const sources = await discoverHistoryTransactions(
      from,
      end,
      false,
      remainingMillis
    );
    Logger.get('NFT_HISTORY').info(
      `[SOURCE] [BLOCKS ${from}-${end}] [FOUND ${sources.length} TRANSACTIONS]`
    );
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      await ingestHistorySource(source, remainingMillis);
      // A partial block must be replayed, including any already committed
      // transactions. Only the final source in a block may move its checkpoint.
      if (sources[index + 1]?.block !== source.block)
        await checkpoint(source.block);
    }
    if (sources[sources.length - 1]?.block !== end) await checkpoint(end);
  }
}

async function ingestHistorySource(
  source: HistoryTransaction,
  remainingMillis: () => number
): Promise<void> {
  if (remainingMillis() < 90000)
    throw new Error(
      'History time budget exhausted; resume after the last completed block'
    );
  try {
    const plan = await prepareTransactionSource(
      source,
      historySourceDb,
      remainingMillis,
      true
    );
    if (plan.claims.length || plan.writes.length)
      await historySourceDb.apply(plan);
  } catch (error) {
    throw Object.assign(
      new Error(
        `History source ${source.hash} at block ${source.block} failed: ${error instanceof Error ? error.message : String(error)}`
      ),
      { cause: error }
    );
  }
}
