import { NFTHistoryReplayJobEntity } from '@/entities/INFTHistoryReplayJob';
import { canonicalJson } from './canonical-json';
import { decodeClaimUpdate } from './claim-events';
import { nftHistoryDb } from './history.db';
import {
  auditHistoryRange,
  manifestDigest,
  planReceipt,
  ReplayManifest,
  verifyReplayRange
} from './replay-manifest';
import { prepareHistoryWrite } from './processor';
import { nftHistoryReplayDb } from './replay.db';
import { ReplayRequest, replayRange } from './replay-request';

type ApplyRequest = Extract<ReplayRequest, { action: 'apply' }>;

async function loadApprovedJob(
  request: ApplyRequest,
  remainingMillis: () => number
): Promise<NFTHistoryReplayJobEntity> {
  const range = replayRange(request);
  const existing = await nftHistoryReplayDb.find(request.jobId);
  if (existing) {
    if (
      existing.digest !== request.approvalDigest ||
      existing.request_json !== canonicalJson(range)
    )
      throw new Error('Job ID is already bound to a different approved replay');
    return existing;
  }
  const manifest = await auditHistoryRange(range, remainingMillis);
  if (manifest.failures.length)
    throw new Error(
      'Audit has unresolved failures; no replay job or history writes were created'
    );
  if (manifestDigest(manifest) !== request.approvalDigest)
    throw new Error('Audit changed since approval; review a fresh dry-run');
  return nftHistoryReplayDb.create(
    request.jobId,
    request.approvalDigest,
    range,
    manifest
  );
}

function parseApprovedManifest(job: NFTHistoryReplayJobEntity): ReplayManifest {
  const manifest = JSON.parse(job.manifest_json) as ReplayManifest;
  if (
    manifest.version !== 1 ||
    canonicalJson(manifest.range) !== job.request_json ||
    manifest.failures.length ||
    manifestDigest(manifest) !== job.digest ||
    !Number.isSafeInteger(job.next_index) ||
    job.next_index < 0 ||
    job.next_index > manifest.entries.length
  ) {
    throw new Error('Invalid stored replay receipt');
  }
  return manifest;
}

async function applyApprovedReplay(
  request: ApplyRequest,
  remainingMillis: () => number
) {
  if (process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED !== 'true')
    throw new Error(
      'Replay apply is disabled; separate execution approval is required'
    );
  const job = await loadApprovedJob(request, remainingMillis);
  const manifest = parseApprovedManifest(job);
  await verifyReplayRange(manifest.range, manifest);
  let index = job.next_index;
  while (index < manifest.entries.length && remainingMillis() >= 90000) {
    const expected = manifest.entries[index];
    const event = await decodeClaimUpdate(expected.log, (contract, claimId) =>
      nftHistoryDb.resolveClaim(contract, claimId)
    );
    const current = await nftHistoryDb.snapshot(event.contract, event.nft_id);
    const plan = await prepareHistoryWrite(event, current);
    if (
      canonicalJson(planReceipt(plan)) !==
      canonicalJson(planReceipt(expected.plan))
    )
      throw new Error(
        'History or metadata changed since approval; stop and review a fresh audit'
      );
    await nftHistoryDb.apply(plan, (manager) =>
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

export async function runHistoryReplay(
  request: ReplayRequest,
  remainingMillis: () => number
) {
  if (request.action === 'apply')
    return applyApprovedReplay(request, remainingMillis);
  // Dry-run does not create jobs, move checkpoints, initialize Redis, or write history.
  const manifest = await auditHistoryRange(
    replayRange(request),
    remainingMillis
  );
  return {
    manifest,
    approvalDigest: manifestDigest(manifest),
    applicable: manifest.failures.length === 0
  };
}
