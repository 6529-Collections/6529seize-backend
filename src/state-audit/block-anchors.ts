import type { Block, BlockTag, Log } from '@/ethereum-rpc/ethereum-rpc-types';
import type { BlockAnchor, BlockAnchors } from './state-audit.manifest';

/** The subset of `EthereumRpcClient` the auditor reads; mocked in tests. */
export interface StateAuditRpc {
  getBlock(blockHashOrBlockTag: BlockTag): Promise<Block>;
  getLogs(filter: {
    address?: string | string[];
    fromBlock?: string;
    toBlock?: string;
    topics?: (string | string[] | null)[];
  }): Promise<Log[]>;
}

export class WindowNotFinalizedError extends Error {
  constructor(
    readonly toBlock: number,
    readonly finalized: number
  ) {
    super(
      `Block ${toBlock} is above the finalized block ${finalized}; audit only finalized windows`
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function anchorOf(block: Block): BlockAnchor {
  if (!block.hash) {
    throw new Error(`Block ${block.number} has no hash`);
  }
  return { number: block.number, hash: block.hash };
}

/**
 * Same pattern as nft-history replay verification: both window ends must be
 * at or below the finalized head, and their hashes are recorded so a later
 * read can prove it inspected the same chain.
 */
export async function readBlockAnchors(
  rpc: Pick<StateAuditRpc, 'getBlock'>,
  fromBlock: number,
  toBlock: number
): Promise<BlockAnchors> {
  const [finalized, from, to] = await Promise.all([
    rpc.getBlock('finalized'),
    rpc.getBlock(fromBlock),
    rpc.getBlock(toBlock)
  ]);
  if (toBlock > finalized.number) {
    throw new WindowNotFinalizedError(toBlock, finalized.number);
  }
  return {
    from_block: anchorOf(from),
    to_block: anchorOf(to),
    finalized: anchorOf(finalized)
  };
}

export function anchorsMatch(a: BlockAnchors, b: BlockAnchors): boolean {
  return (
    a.from_block.number === b.from_block.number &&
    a.from_block.hash === b.from_block.hash &&
    a.to_block.number === b.to_block.number &&
    a.to_block.hash === b.to_block.hash
  );
}
