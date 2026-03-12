import { getRpcProvider } from '@/rpc-provider';
import { Network } from 'alchemy-sdk';
import { Contract, ethers } from 'ethers';

const ERC721_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function supportsInterface(bytes4) view returns (bool)'
] as const;

const ERC721_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC721_INTERFACE_ID = '0x80ac58cd';

export interface ArtCurationTokenSubmissionSnapshot {
  readonly blockNumber: number;
  readonly observedAt: number;
  readonly owner: string;
  readonly isTrackable: boolean;
}

export interface ArtCurationTokenTransferEvent {
  readonly txHash: string;
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly timestampMs: number;
}

export class ArtCurationTokenWatchOnchainService {
  private static readonly APPROX_BLOCK_TIME_SECONDS = 12;

  private providerInstance: ReturnType<typeof getRpcProvider> | null = null;

  private get provider() {
    if (!this.providerInstance) {
      this.providerInstance = getRpcProvider(Network.ETH_MAINNET);
    }
    return this.providerInstance;
  }

  public async snapshotSubmissionState({
    contract,
    tokenId
  }: {
    contract: string;
    tokenId: string;
  }): Promise<ArtCurationTokenSubmissionSnapshot> {
    const blockNumber = await this.provider.getBlockNumber();
    return this.snapshotSubmissionStateAtBlock({
      contract,
      tokenId,
      blockNumber,
      observedAt: Date.now()
    });
  }

  public async snapshotSubmissionStateAtBlock({
    contract,
    tokenId,
    blockNumber,
    observedAt
  }: {
    contract: string;
    tokenId: string;
    blockNumber: number;
    observedAt: number;
  }): Promise<ArtCurationTokenSubmissionSnapshot> {
    const nft = new Contract(contract, ERC721_ABI, this.provider);
    let supportsErc721;
    try {
      supportsErc721 = await nft.supportsInterface(ERC721_INTERFACE_ID, {
        blockTag: blockNumber
      });
    } catch {
      supportsErc721 = false;
    }
    try {
      const owner = await nft.ownerOf(BigInt(tokenId), {
        blockTag: blockNumber
      });
      return {
        blockNumber,
        observedAt,
        owner: String(owner).toLowerCase(),
        isTrackable: true
      };
    } catch (error) {
      if (supportsErc721 || this.looksLikeUnmintedErc721(error)) {
        return {
          blockNumber,
          observedAt,
          owner: ethers.ZeroAddress,
          isTrackable: true
        };
      }
      return {
        blockNumber,
        observedAt,
        owner: ethers.ZeroAddress,
        isTrackable: false
      };
    }
  }

  public async findLatestBlockBeforeTimestamp(
    targetTimestampMs: number
  ): Promise<{ number: number; timestampMs: number }> {
    const targetTimestampSeconds = Math.floor(targetTimestampMs / 1000);
    const latestBlock = await this.provider.getBlock('latest');
    if (!latestBlock) {
      throw new Error('Latest block not found');
    }

    let startBlock = Math.max(
      0,
      latestBlock.number -
        Math.floor(
          (latestBlock.timestamp - targetTimestampSeconds) /
            ArtCurationTokenWatchOnchainService.APPROX_BLOCK_TIME_SECONDS
        )
    );
    let endBlock = latestBlock.number;

    while (startBlock <= endBlock) {
      const midBlockNumber = Math.floor((startBlock + endBlock) / 2);
      const midBlock = await this.provider.getBlock(midBlockNumber);
      if (!midBlock) {
        throw new Error(`Block ${midBlockNumber} not found`);
      }
      if (midBlock.timestamp === targetTimestampSeconds) {
        return {
          number: midBlock.number,
          timestampMs: midBlock.timestamp * 1000
        };
      }
      if (midBlock.timestamp < targetTimestampSeconds) {
        startBlock = midBlockNumber + 1;
      } else {
        endBlock = midBlockNumber - 1;
      }
    }

    const blockBefore = await this.provider.getBlock(Math.max(endBlock, 0));
    if (!blockBefore) {
      throw new Error('Block before not found');
    }
    return {
      number: blockBefore.number,
      timestampMs: blockBefore.timestamp * 1000
    };
  }

  public async findFirstTransfer({
    contract,
    tokenId,
    fromBlock,
    reorgDepth,
    maxRange
  }: {
    contract: string;
    tokenId: string;
    fromBlock: number;
    reorgDepth: number;
    maxRange: number;
  }): Promise<{
    checkedThroughBlock: number;
    event: ArtCurationTokenTransferEvent | null;
  }> {
    const bestBlock = await this.provider.getBlockNumber();
    const safeHead = Math.max(0, bestBlock - reorgDepth);
    if (fromBlock > safeHead) {
      return {
        checkedThroughBlock: safeHead,
        event: null
      };
    }
    const toBlock = Math.min(safeHead, fromBlock + maxRange - 1);
    const logs = await this.provider.getLogs({
      address: contract,
      topics: [
        ERC721_TRANSFER_TOPIC,
        null,
        null,
        ethers.toBeHex(BigInt(tokenId), 32)
      ],
      fromBlock,
      toBlock
    });
    if (!logs.length) {
      return {
        checkedThroughBlock: toBlock,
        event: null
      };
    }
    const [firstLog] = logs.sort(
      (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
    );
    const block = await this.provider.getBlock(firstLog.blockNumber);
    if (!block) {
      throw new Error(`Block ${firstLog.blockNumber} not found`);
    }
    return {
      checkedThroughBlock: toBlock,
      event: {
        txHash: firstLog.transactionHash,
        blockNumber: firstLog.blockNumber,
        logIndex: firstLog.index,
        timestampMs: block.timestamp * 1000
      }
    };
  }

  public async findTransfersThroughSafeHead({
    contract,
    tokenId,
    fromBlock,
    reorgDepth,
    maxRange
  }: {
    contract: string;
    tokenId: string;
    fromBlock: number;
    reorgDepth: number;
    maxRange: number;
  }): Promise<{
    safeHead: number;
    events: ArtCurationTokenTransferEvent[];
  }> {
    const bestBlock = await this.provider.getBlockNumber();
    const safeHead = Math.max(0, bestBlock - reorgDepth);
    if (fromBlock > safeHead) {
      return {
        safeHead,
        events: []
      };
    }

    const events: ArtCurationTokenTransferEvent[] = [];
    const timestampByBlock = new Map<number, number>();
    let currentFromBlock = fromBlock;

    while (currentFromBlock <= safeHead) {
      const toBlock = Math.min(safeHead, currentFromBlock + maxRange - 1);
      const logs = await this.provider.getLogs({
        address: contract,
        topics: [
          ERC721_TRANSFER_TOPIC,
          null,
          null,
          ethers.toBeHex(BigInt(tokenId), 32)
        ],
        fromBlock: currentFromBlock,
        toBlock
      });

      const orderedLogs = logs.sort(
        (a, b) => a.blockNumber - b.blockNumber || a.index - b.index
      );

      for (const log of orderedLogs) {
        let timestampMs = timestampByBlock.get(log.blockNumber);
        if (timestampMs == null) {
          const block = await this.provider.getBlock(log.blockNumber);
          if (!block) {
            throw new Error(`Block ${log.blockNumber} not found`);
          }
          timestampMs = block.timestamp * 1000;
          timestampByBlock.set(log.blockNumber, timestampMs);
        }
        events.push({
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.index,
          timestampMs
        });
      }

      currentFromBlock = toBlock + 1;
    }

    return {
      safeHead,
      events
    };
  }

  private looksLikeUnmintedErc721(error: unknown): boolean {
    let message: string;
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else {
      message = JSON.stringify(error ?? {});
    }
    const lowered = message.toLowerCase();
    return (
      lowered.includes('nonexistent token') ||
      lowered.includes('owner query for nonexistent token') ||
      lowered.includes('invalid token id') ||
      lowered.includes('invalid tokenid') ||
      lowered.includes('token does not exist') ||
      lowered.includes('not minted')
    );
  }
}

export const artCurationTokenWatchOnchainService =
  new ArtCurationTokenWatchOnchainService();
