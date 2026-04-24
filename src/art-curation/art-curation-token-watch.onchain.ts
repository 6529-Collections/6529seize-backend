import { getRpcProvider } from '@/rpc-provider';
import { getBestEffortArtCurationTransferPrice } from '@/art-curation/art-curation-token-watch-price';
import { Network } from '@/alchemy-sdk';
import { Contract, ethers } from 'ethers';

const ERC721_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function supportsInterface(bytes4) view returns (bool)'
] as const;
const ERC20_ABI = ['function decimals() view returns (uint8)'] as const;

const ERC721_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC721_INTERFACE_ID = '0x80ac58cd';

export interface ArtCurationTokenSubmissionSnapshot {
  readonly blockNumber: number;
  readonly observedAt: number;
  readonly owner: string;
  readonly isTrackable: boolean;
}

export interface ArtCurationTokenTransferEvent {
  readonly from: string;
  readonly to: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly timestampMs: number;
}

export interface ArtCurationTokenTransferPrice {
  readonly amountRaw: string | null;
  readonly amount: number | null;
  readonly currency: string | null;
}

export class ArtCurationTokenWatchOnchainService {
  private providerInstance: ReturnType<typeof getRpcProvider> | null = null;
  private readonly erc20DecimalsCache = new Map<string, Promise<number>>();

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
    const observedAt = Date.now();
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
        from: ethers
          .getAddress(`0x${firstLog.topics[1].slice(-40)}`)
          .toLowerCase(),
        to: ethers
          .getAddress(`0x${firstLog.topics[2].slice(-40)}`)
          .toLowerCase(),
        txHash: firstLog.transactionHash,
        blockNumber: firstLog.blockNumber,
        logIndex: firstLog.index,
        timestampMs: block.timestamp * 1000
      }
    };
  }

  public async findTransferPrice({
    txHash,
    contract,
    tokenId
  }: {
    txHash: string;
    contract: string;
    tokenId: string;
  }): Promise<ArtCurationTokenTransferPrice> {
    const [transaction, receipt] = await Promise.all([
      this.provider.getTransaction(txHash),
      this.provider.getTransactionReceipt(txHash)
    ]);
    const attribution = getBestEffortArtCurationTransferPrice({
      transaction: transaction
        ? {
            from: transaction.from ?? null,
            value: transaction.value
          }
        : null,
      receipt,
      contract,
      tokenId
    });
    if (!attribution.amountRaw || !attribution.currency) {
      return {
        amountRaw: null,
        amount: null,
        currency: null
      };
    }
    const decimals = await this.getCurrencyDecimals(attribution.currency);
    return {
      amountRaw: attribution.amountRaw,
      amount: Number.parseFloat(
        ethers.formatUnits(BigInt(attribution.amountRaw), decimals)
      ),
      currency: attribution.currency
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

  private async getCurrencyDecimals(currency: string): Promise<number> {
    if (currency === ethers.ZeroAddress.toLowerCase()) {
      return 18;
    }
    const key = currency.toLowerCase();
    if (!this.erc20DecimalsCache.has(key)) {
      this.erc20DecimalsCache.set(key, this.fetchCurrencyDecimals(currency));
    }
    return await this.erc20DecimalsCache.get(key)!;
  }

  private async fetchCurrencyDecimals(currency: string): Promise<number> {
    try {
      const erc20 = new Contract(currency, ERC20_ABI, this.provider);
      return Number(await erc20.decimals());
    } catch {
      return 18;
    }
  }
}

export const artCurationTokenWatchOnchainService =
  new ArtCurationTokenWatchOnchainService();
