import { JsonRpcProvider } from 'ethers';
import { MANIFOLD, NULL_ADDRESS, TRANSACTIONS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { sqlExecutor } from '@/sql-executor';
import {
  readScanCheckpoint,
  ScanCheckpoint
} from '@/transactions/transaction-scan-checkpoint';
import {
  LaunchData,
  LaunchSafetyError,
  SupplyEvidence,
  SupplyEvidenceError
} from './drop-forge.types';

export interface ClaimSupply {
  total: number;
  edition: number;
  token: number;
  end: number;
}

function assertClaimSupply(data: LaunchData, claim: ClaimSupply): void {
  if (
    claim.token !== data.claim_id ||
    claim.edition !== data.edition_size ||
    claim.end !== data.phases.at(-1)!.end ||
    !Number.isSafeInteger(claim.total) ||
    claim.total < 0 ||
    claim.total > data.edition_size
  )
    throw new LaunchSafetyError(
      'Finalized claim supply or configuration differs from Craft'
    );
}

async function finalizedSupplyBlock(
  data: LaunchData,
  provider: JsonRpcProvider,
  evidence: SupplyEvidence,
  minimumBlock: number,
  checkpoint: ScanCheckpoint | null
): Promise<{ number: number; hash: string; timestamp: number }> {
  const head = await provider.getBlock('latest');
  if (
    !head ||
    !Number.isSafeInteger(head.timestamp) ||
    Math.abs(Date.now() / 1000 - head.timestamp) > 120
  )
    throw new LaunchSafetyError('RPC latest block is stale');
  const finalized = await provider.getBlock('finalized');
  if (!checkpoint || !Number.isSafeInteger(Number(checkpoint.block)))
    throw new LaunchSafetyError(
      'Transaction indexing has not completed through the comparison block'
    );
  const block =
    finalized && Number(checkpoint.block) < finalized.number
      ? await provider.getBlock(Number(checkpoint.block))
      : finalized;
  if (
    !block?.hash ||
    !Number.isSafeInteger(block.number) ||
    !Number.isSafeInteger(block.timestamp) ||
    !finalized ||
    block.number > finalized.number ||
    finalized.number > head.number ||
    block.timestamp > finalized.timestamp ||
    finalized.timestamp > head.timestamp
  )
    throw new LaunchSafetyError('Finalized supply block is unavailable');
  Object.assign(evidence, {
    block_number: block.number,
    block_hash: block.hash,
    block_timestamp: block.timestamp
  });
  if (block.timestamp <= data.phases.at(-1)!.end || block.number < minimumBlock)
    throw new LaunchSafetyError('Waiting for finalized post-mint evidence');
  if (finalized.timestamp - block.timestamp > 300)
    throw new LaunchSafetyError(
      'Transaction indexing coverage is more than five minutes behind finalized chain state'
    );
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}

export async function indexedMintTotals(
  data: Pick<LaunchData, 'contract' | 'claim_id'>,
  block: number
): Promise<{ total: number; paid: number }> {
  const row = await sqlExecutor.oneOrNull<{ total: string; paid: string }>(
    `SELECT COALESCE(SUM(token_count), 0) AS total, COALESCE(SUM(CASE WHEN value > 0 THEN token_count ELSE 0 END), 0) AS paid FROM ${TRANSACTIONS_TABLE} WHERE contract = :contract AND token_id = :claim AND block <= :block AND from_address IN (:zero, :manifold) AND to_address NOT IN (:zero, :manifold)`,
    {
      contract: data.contract.toLowerCase(),
      claim: data.claim_id,
      block,
      zero: NULL_ADDRESS,
      manifold: MANIFOLD
    },
    { forcePool: DbPoolName.WRITE }
  );
  const total = Number(row?.total);
  const paid = Number(row?.paid);
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(paid) ||
    paid < 0 ||
    paid > total
  )
    throw new LaunchSafetyError('Indexed mint accounting is invalid');
  return { total, paid };
}

export async function verifyIndexedSupply(
  data: LaunchData,
  provider: JsonRpcProvider,
  read: (hash: string) => Promise<ClaimSupply>,
  minimumBlock = 0
): Promise<SupplyEvidence> {
  const evidence: SupplyEvidence = {
    status: 'WAITING',
    checked_at: Date.now()
  };
  try {
    const checkpoint = await readScanCheckpoint(data.chain_id, data.contract);
    evidence.indexed_through = checkpoint
      ? Number(checkpoint.block)
      : undefined;
    const block = await finalizedSupplyBlock(
      data,
      provider,
      evidence,
      minimumBlock,
      checkpoint
    );
    const claim = await read(block.hash);
    evidence.rpc_total = claim.total;
    assertClaimSupply(data, claim);
    const indexed = await indexedMintTotals(data, block.number);
    evidence.db_total = indexed.total;
    if (!checkpoint || Number(checkpoint.block) < block.number)
      throw new LaunchSafetyError(
        'Transaction indexing has not completed through the comparison block'
      );
    const indexedBlock = await provider.getBlock(Number(checkpoint.block));
    if (indexedBlock?.hash !== checkpoint.block_hash)
      throw new LaunchSafetyError('Indexing checkpoint is no longer canonical');
    if (indexed.total !== claim.total)
      throw new LaunchSafetyError(
        `Mint accounting mismatch: RPC ${claim.total}, database ${indexed.total} at block ${block.number}`
      );
    const canonical = await provider.getBlock(block.number);
    if (canonical?.hash !== block.hash)
      throw new LaunchSafetyError(
        'Supply comparison block changed during verification'
      );
    evidence.status = 'VERIFIED';
    return evidence;
  } catch (error) {
    throw new SupplyEvidenceError(
      evidence,
      error instanceof LaunchSafetyError
        ? error.message
        : 'RPC or database supply verification is unavailable'
    );
  }
}
