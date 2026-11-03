import { MEMELAB_CONTRACT, MEMES_CONTRACT } from '@/constants';
import { NFTHistory } from '@/entities/INFTHistory';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { canonicalJson, historyDigest } from './canonical-json';
import { compareHistoryPosition } from './claim-events';
import {
  HistorySnapshot,
  HistoryWritePlan,
  historyFingerprint,
  nftHistoryDb
} from './history.db';
import { recordVerifiedEdit } from './processor';
import { nftHistoryReplayDb } from './replay.db';
import { planReceipt, verifyReplayRange } from './replay-manifest';
import { applyIdentity, MAX_REPLAY_EVENTS } from './replay-request';
import { decodeHistorySource, toSourceLog } from './source-operations';

const MODE = 'nft-history-repair';

interface RepairScope {
  mode: typeof MODE;
  contract: string;
  tokenId: number;
  cutoffBlock: number;
  mintTransaction?: string;
  editTransactions: string[];
}

type RepairRequest = RepairScope &
  (
    | { action: 'dry-run' }
    | { action: 'apply'; jobId: string; approvalDigest: string }
  );

function transactionHash(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[\da-f]{64}$/i.test(value))
    throw new Error('Invalid repair transaction hash');
  return value.toLowerCase();
}

export function parseHistoryRepairRequest(
  event: unknown
): RepairRequest | null {
  if (!event || typeof event !== 'object') return null;
  const input = event as Record<string, unknown>;
  if (input.mode !== MODE) return null;
  const contract = [MEMES_CONTRACT, MEMELAB_CONTRACT].find(
    (address) => address.toLowerCase() === String(input.contract).toLowerCase()
  );
  const allowed = new Set([
    'mode',
    'action',
    'contract',
    'tokenId',
    'cutoffBlock',
    'mintTransaction',
    'editTransactions',
    ...(input.action === 'apply' ? ['jobId', 'approvalDigest'] : [])
  ]);
  if (
    !contract ||
    !['dry-run', 'apply'].includes(String(input.action)) ||
    Object.keys(input).some((key) => !allowed.has(key)) ||
    !Number.isSafeInteger(input.tokenId) ||
    Number(input.tokenId) < 0 ||
    Number(input.tokenId) > 2147483647 ||
    !Number.isSafeInteger(input.cutoffBlock) ||
    Number(input.cutoffBlock) < 1 ||
    !Array.isArray(input.editTransactions) ||
    input.editTransactions.length > MAX_REPLAY_EVENTS
  )
    throw new Error('Invalid NFT history repair request');

  const editTransactions = input.editTransactions.map(transactionHash);
  const mintTransaction =
    input.mintTransaction === undefined
      ? undefined
      : transactionHash(input.mintTransaction);
  if (
    (!mintTransaction && !editTransactions.length) ||
    new Set(editTransactions).size !== editTransactions.length ||
    (mintTransaction && editTransactions.includes(mintTransaction))
  )
    throw new Error('Repair requires distinct, explicit source transactions');

  const scope: RepairScope = {
    mode: MODE,
    contract,
    tokenId: Number(input.tokenId),
    cutoffBlock: Number(input.cutoffBlock),
    ...(mintTransaction ? { mintTransaction } : {}),
    editTransactions: editTransactions.sort((a, b) => a.localeCompare(b))
  };
  return input.action === 'apply'
    ? { ...scope, action: 'apply', ...applyIdentity(input) }
    : { ...scope, action: 'dry-run' };
}

function repairRange(scope: RepairScope) {
  return {
    fromBlock: scope.cutoffBlock,
    toBlock: scope.cutoffBlock,
    cutoffBlock: scope.cutoffBlock
  };
}

async function decodeRepairTransaction(
  scope: RepairScope,
  hash: string,
  mint: boolean,
  remainingMillis: () => number
) {
  if (remainingMillis() < 90000)
    throw new Error('Insufficient time to verify repair sources');
  const rpc = getEthereumRpcClient();
  const [tx, receipt] = await Promise.all([
    rpc.getTransaction(hash),
    rpc.getTransactionReceipt(hash)
  ]);
  if (
    !tx ||
    !receipt ||
    receipt.status !== 1 ||
    tx.blockNumber === null ||
    tx.blockNumber > scope.cutoffBlock
  )
    throw new Error(
      'Repair source must be successful and within the finalized cutoff'
    );
  return decodeHistorySource(
    {
      hash,
      block: tx.blockNumber,
      transactionIndex: tx.index,
      logs: receipt.logs.map(toSourceLog)
    },
    {
      hasMint: async (contract, id) =>
        !mint ||
        contract.toLowerCase() !== scope.contract.toLowerCase() ||
        id !== scope.tokenId,
      remainingMillis
    }
  );
}

function isRepairToken(
  scope: RepairScope,
  row: Pick<NFTHistory, 'contract' | 'nft_id'>
) {
  return (
    row.contract.toLowerCase() === scope.contract.toLowerCase() &&
    row.nft_id === scope.tokenId
  );
}

function planMintReplacement(
  snapshot: HistorySnapshot,
  plan: HistoryWritePlan,
  row: NFTHistory,
  verifiedEdits: ReadonlyMap<string, boolean>
): void {
  const mints = snapshot.legacy.filter(
    (entry) => entry.description?.event === 'Mint'
  );
  const old = mints[0];
  if (mints.length !== 1 || !old.uri || !row.uri || row.uri.length > 100)
    throw new Error(
      'Repair requires one existing Mint and a storable canonical URI'
    );
  if (
    old.uri === row.uri &&
    old.block === row.block &&
    old.transaction_hash.toLowerCase() === row.transaction_hash.toLowerCase() &&
    new Date(old.transaction_date).getTime() === row.transaction_date.getTime()
  )
    return;

  // Legacy history uses URI as part of its primary key. Only displace a
  // collision after preserving its source in the ledger as settings-only.
  const collision = snapshot.legacy.find(
    (entry) =>
      entry !== old && entry.uri?.toLowerCase() === row.uri!.toLowerCase()
  );
  if (
    collision &&
    (collision.description?.event !== 'Edit' ||
      verifiedEdits.get(collision.transaction_hash.toLowerCase()) !== true)
  )
    throw new Error(
      'Mint URI collision requires a verified settings-only source'
    );

  if (old.uri !== row.uri) {
    const successors = [...snapshot.legacy, ...snapshot.events]
      .filter(
        (entry) =>
          entry !== old &&
          entry.block >= row.block &&
          entry.description !== null
      )
      .sort((a, b) => a.block - b.block);
    const nextBlock = successors[0]?.block;
    if (
      successors.some(
        (entry) =>
          entry.block === nextBlock &&
          !verifiedEdits.has(entry.transaction_hash.toLowerCase())
      )
    )
      throw new Error(
        'Mint URI correction requires verification of its first successor'
      );
  }

  const { created_at: _createdAt, ...canonical } = row;
  plan.replaceMint = {
    oldUri: old.uri,
    ...(collision ? { collisionUri: collision.uri } : {}),
    row: canonical
  };
}

async function prepareRepair(
  scope: RepairScope,
  remainingMillis: () => number
) {
  const range = repairRange(scope);
  const { cutoffHash } = await verifyReplayRange(range);
  const snapshot = await nftHistoryDb.snapshot(scope.contract, scope.tokenId);
  const plan: HistoryWritePlan = {
    contract: scope.contract,
    nft_id: scope.tokenId,
    before: historyFingerprint(snapshot),
    inserts: [],
    eventUpdates: [],
    legacyUpdates: []
  };

  const verifiedEdits = new Map<string, boolean>();
  for (const hash of scope.editTransactions) {
    const operations = await decodeRepairTransaction(
      scope,
      hash,
      false,
      remainingMillis
    );
    const edits = operations.filter(
      (operation) =>
        operation.kind === 'edit' && isRepairToken(scope, operation.event)
    );
    const edit = edits[0];
    if (edits.length !== 1 || edit.kind !== 'edit' || !edit.previousUri)
      throw new Error(
        'Repair requires one verified claim edit for the selected NFT per source'
      );
    await recordVerifiedEdit(plan, snapshot, edit.event, edit.previousUri);
    verifiedEdits.set(hash, edit.previousUri === edit.event.uri);
  }

  if (scope.mintTransaction) {
    const operations = await decodeRepairTransaction(
      scope,
      scope.mintTransaction,
      true,
      remainingMillis
    );
    const mints = operations.filter(
      (operation) =>
        operation.kind === 'mint' && isRepairToken(scope, operation.row)
    );
    const mint = mints[0];
    if (mints.length !== 1 || mint.kind !== 'mint')
      throw new Error(
        'Repair requires a verified first Mint source for the selected NFT'
      );
    planMintReplacement(snapshot, plan, mint.row, verifiedEdits);
  }

  if ((await verifyReplayRange(range)).cutoffHash !== cutoffHash)
    throw new Error('Repair cutoff changed; review a fresh dry-run');
  plan.inserts.sort(compareHistoryPosition);
  const manifest = { version: 1, scope, cutoffHash, plan };
  if (Buffer.byteLength(canonicalJson(manifest)) > 2_000_000)
    throw new Error('Repair manifest too large');
  return manifest;
}

function repairDigest(
  manifest: Awaited<ReturnType<typeof prepareRepair>>
): string {
  return historyDigest({ ...manifest, plan: planReceipt(manifest.plan) });
}

export async function runHistoryRepair(
  request: RepairRequest,
  remainingMillis: () => number
) {
  if (request.action === 'dry-run') {
    const { action: _action, ...scope } = request;
    const manifest = await prepareRepair(scope, remainingMillis);
    return {
      manifest,
      approvalDigest: repairDigest(manifest),
      applicable: true
    };
  }
  if (process.env.NFT_HISTORY_REPLAY_APPLY_ENABLED !== 'true')
    throw new Error(
      'Repair apply is disabled; separate execution approval is required'
    );

  const { action: _action, jobId, approvalDigest, ...scope } = request;
  const receipt = { jobId, approvalDigest, complete: true };
  const job = await nftHistoryReplayDb.find(jobId);
  if (job) {
    const manifest = JSON.parse(job.manifest_json) as Awaited<
      ReturnType<typeof prepareRepair>
    >;
    if (
      job.request_json !== canonicalJson(scope) ||
      job.digest !== approvalDigest ||
      manifest.version !== 1 ||
      canonicalJson(manifest.scope) !== job.request_json ||
      repairDigest(manifest) !== approvalDigest ||
      ![0, 1].includes(job.next_index)
    )
      throw new Error('Invalid or differently scoped repair receipt');
    if (job.next_index === 1) return receipt;
  }

  const manifest = await prepareRepair(scope, remainingMillis);
  if (repairDigest(manifest) !== approvalDigest)
    throw new Error(
      'Repair evidence or stored history changed; review a fresh dry-run'
    );
  if (!job)
    await nftHistoryReplayDb.create(jobId, approvalDigest, scope, manifest);
  if (remainingMillis() < 90000)
    throw new Error('Repair job saved; resume with the same job ID');
  await nftHistoryDb.apply(manifest.plan, (manager) =>
    nftHistoryReplayDb.advance(manager, jobId, 0)
  );
  return receipt;
}
