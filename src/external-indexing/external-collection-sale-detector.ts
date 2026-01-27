import { externalIndexerRpc, ExternalIndexerRpc } from './external-indexer-rpc';
import { ethers } from 'ethers';

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC721_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)'); // same sig; we exclude NFT logs by address

// Seaport (v1.1 + v1.5), Blur Exchange, Blur Pool (common helper)
const DEFAULT_MARKET_ADDRESSES = new Set<string>(
  [
    '0x00000000006c3852cbef3e08e8df289169ede581',
    '0x00000000000000adc04c56bf30ac9d3c0aaf14dc',
    '0x000000000000ad05ccc4f10045630fb830b95127',
    '0x0000000000a39bb272e79075ade125fd351887ac'
  ].map((a) => a.toLowerCase())
);

export class ExternalCollectionSaleDetector {
  constructor(private readonly rpc: ExternalIndexerRpc) {}

  public async isSale({
    txHash,
    contract
  }: {
    txHash: string;
    contract: string;
  }): Promise<boolean> {
    const provider = this.rpc.provider;
    const nftLc = contract.toLowerCase();

    const tx = await this.withRetries(() => provider.getTransaction(txHash));
    const receipt = await this.withRetries(() =>
      provider.getTransactionReceipt(txHash)
    );

    // If we can’t fetch either, treat as not-a-sale (you could choose “unknown” instead)
    if (!tx || !receipt) return false;

    // 1) ETH payment
    const ethValue = tx.value ?? BigInt(0);
    const ethPaid = ethValue > BigInt(0);

    // 2) ERC-20 payment: any ERC-20 Transfer in the tx that wasn't emitted by the NFT contract
    const erc20Paid = receipt.logs.some(
      (l) =>
        l.topics?.length >= 1 &&
        l.topics[0] === ERC20_TRANSFER_TOPIC &&
        (l.address || '').toLowerCase() !== nftLc
    );

    // 3) Marketplace involvement: direct call OR any log from known marketplace
    const marketplacesTouched = new Set<string>();
    const toLc = (tx.to || '').toLowerCase();
    if (toLc && DEFAULT_MARKET_ADDRESSES.has(toLc))
      marketplacesTouched.add(toLc);

    for (const l of receipt.logs) {
      const la = (l.address || '').toLowerCase();
      if (DEFAULT_MARKET_ADDRESSES.has(la)) marketplacesTouched.add(la);
    }
    const marketplaceHit = marketplacesTouched.size > 0;

    // Final rule: OR
    return ethPaid || erc20Paid || marketplaceHit;
  }

  // Simple retry helper to smooth over transient RPC hiccups
  private async withRetries<T>(
    fn: () => Promise<T>,
    tries = 3,
    baseDelayMs = 200
  ): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < tries; i++) {
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) {
        lastErr = e;
      }
      if (i < tries - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
      }
    }
    if (lastErr) throw lastErr;
    // If the RPC returned a falsy value each time but no error, just return it
    return undefined as unknown as T;
  }
}

export const externalCollectionSaleDetector =
  new ExternalCollectionSaleDetector(externalIndexerRpc);
