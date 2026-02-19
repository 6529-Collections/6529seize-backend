import type { AdapterResult, PlatformAdapter } from './types';
import { Contract } from 'ethers';

import { fetchJsonWithTimeout } from '../lib/http';
import { normalizeMetadataUri } from '../lib/uri';
import { buildPrimaryAction } from '../lib/market';
import { formatTokenAmount, getProvider } from '../lib/onchain';
import { CanonicalLink } from '@/nft-links/types';
import { numbers } from '@/numbers';
import { Time } from '@/time';
import { env } from '@/env';
import { NULL_ADDRESS } from '@/constants';

/**
 * Foundation
 *
 * We resolve Foundation primarily via onchain reads.
 * This avoids brittle HTML scraping on a JS-heavy site.
 */

const FOUNDATION_MARKET_ABI = [
  // Verified in Foundation's audited NFTMarket mixins.
  // getBuyPrice returns price=type(uint256).max and seller=address(0) when unset.
  'function getBuyPrice(address nftContract, uint256 tokenId) view returns (address seller, uint256 price)',

  // Reserve auction lookup is 2-step:
  // 1) getReserveAuctionIdFor(contract, tokenId) => uint256
  // 2) getReserveAuction(auctionId) => ReserveAuction struct
  'function getReserveAuctionIdFor(address nftContract, uint256 tokenId) view returns (uint256)',
  'function getReserveAuction(uint256 auctionId) view returns (address nftContract, uint256 tokenId, address seller, uint256 duration, uint256 extensionDuration, uint256 endTime, address bidder, uint256 amount)'
];

const ERC721_METADATA_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function name() view returns (string)'
];

const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

type MetadataJson = Record<string, any>;

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

export class FoundationAdapter implements PlatformAdapter {
  canHandle(canonical: CanonicalLink): boolean {
    return (
      canonical.platform === 'FOUNDATION' &&
      (canonical.identifiers.kind === 'TOKEN' ||
        canonical.identifiers.kind === 'CONTRACT_ONLY')
    );
  }

  async resolveFast(canonical: CanonicalLink): Promise<AdapterResult | null> {
    const ids: any = canonical.identifiers as any;
    if (ids.kind !== 'TOKEN' && ids.kind !== 'CONTRACT_ONLY') return null;

    const chain = ids.chain;
    const contract = ids.contract;
    let tokenId: string | undefined =
      ids.kind === 'TOKEN' ? ids.tokenId : undefined;
    const timeoutMs = env.getIntOrNull('FOUNDATION_TIMEOUT_MS') ?? 1800;

    // Foundation is Ethereum mainnet today; if someone passes other chain, we still try if RPC is provided.
    const provider = getProvider(chain);
    const market = new Contract(
      this.getFoundationMarketAddress(),
      FOUNDATION_MARKET_ABI,
      provider
    );
    const nft = new Contract(contract, ERC721_METADATA_ABI, provider);

    // If Foundation URL omitted tokenId (contract-level mint URL), try a small heuristic discovery.
    // This is intentionally conservative: we only probe a few candidate tokenIds.
    if (!tokenId) {
      const candidates = (
        env.getStringOrNull('FOUNDATION_TOKENID_DISCOVERY_CANDIDATES') ?? '1,0'
      )
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));

      for (const c of candidates) {
        try {
          const uri = await nft.tokenURI(BigInt(c)).catch(() => undefined);
          if (uri && String(uri).length > 0) {
            tokenId = String(c);
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    // Onchain market state (only when we have tokenId)
    let buySeller: string | undefined;
    let buyPrice: bigint | undefined;
    let auctionSeller: string | undefined;
    let reserveOrBidAmount: bigint | undefined;
    let endTime: bigint | undefined;

    if (tokenId) {
      try {
        const [seller, price] = await market.getBuyPrice(
          contract,
          BigInt(tokenId)
        );
        buySeller = String(seller);
        buyPrice = BigInt(price);
      } catch {
        // ignore
      }

      try {
        const auctionId = await market.getReserveAuctionIdFor(
          contract,
          BigInt(tokenId)
        );
        const aId = BigInt(auctionId);
        if (aId > BigInt(0)) {
          const res = await market.getReserveAuction(aId);
          // (address nftContract, uint256 tokenId, address seller, uint256 duration, uint256 extensionDuration, uint256 endTime, address bidder, uint256 amount)
          const nftContract = String(
            res?.[0] ?? res?.nftContract ?? ''
          ).toLowerCase();
          const seller = String(res?.[2] ?? res?.seller ?? '');
          const aEnd = BigInt(res?.[5] ?? res?.endTime ?? 0);
          const aAmount = BigInt(res?.[7] ?? res?.amount ?? 0);

          if (nftContract && nftContract !== NULL_ADDRESS) {
            auctionSeller = seller;
            reserveOrBidAmount = aAmount;
            endTime = aEnd;
          }
        }
      } catch {
        // ignore
      }
    }

    // Interpret state
    let saleType: 'FIXED' | 'AUCTION' | 'NOT_FOR_SALE' | 'UNKNOWN' = 'UNKNOWN';
    let price: { amount: string; currency: string } | undefined;
    let endsAt: string | undefined;

    const hasBuy =
      buyPrice != null &&
      buyPrice !== UINT256_MAX &&
      buySeller &&
      buySeller !== NULL_ADDRESS;
    const hasAuction =
      reserveOrBidAmount != null &&
      reserveOrBidAmount > BigInt(0) &&
      auctionSeller &&
      auctionSeller !== NULL_ADDRESS;

    if (hasBuy) {
      saleType = 'FIXED';
      price = { amount: formatTokenAmount(buyPrice!, 18), currency: 'ETH' };
    } else if (hasAuction) {
      saleType = 'AUCTION';
      // Reserve auction stores either reserve price (no bids) or current high bid.
      price = {
        amount: formatTokenAmount(reserveOrBidAmount!, 18),
        currency: 'ETH'
      };
      const endsAtSec = numbers.parseIntOrNull(endTime);
      endsAt = endsAtSec
        ? Time.seconds(endsAtSec).toIsoDateTimeString()
        : undefined;
    } else if (tokenId) {
      // If we have a tokenId and no sale signals, it's likely not listed on Foundation market.
      saleType = 'NOT_FOR_SALE';
    }

    // Token metadata (only when we have tokenId)
    let tokenUri: string | undefined;
    let collectionName: string | undefined;
    try {
      [tokenUri, collectionName] = await Promise.all([
        tokenId
          ? nft.tokenURI(BigInt(tokenId)).catch(() => undefined)
          : Promise.resolve(undefined),
        nft.name().catch(() => undefined)
      ]);
    } catch {
      // ignore
    }

    let meta: MetadataJson | undefined;
    if (tokenUri) {
      const resolvedUri = normalizeMetadataUri(tokenUri);
      if (resolvedUri) {
        try {
          meta = await fetchJsonWithTimeout<MetadataJson>(resolvedUri, {
            timeoutMs
          });
        } catch {
          // ignore
        }
      }
    }

    const title = pick<string>(meta?.name, meta?.title);
    const description = pick<string>(meta?.description);
    const imageUrl = normalizeMetadataUri(
      pick<string>(meta?.image, meta?.image_url, meta?.imageUrl)
    );
    const animationUrl = normalizeMetadataUri(
      pick<string>(meta?.animation_url, meta?.animationUrl)
    );

    const patch: any = {
      chain,
      asset: {
        title,
        description,
        collection: collectionName ? { name: collectionName } : undefined,
        contract,
        tokenId,
        media: animationUrl
          ? { kind: 'animation', imageUrl, animationUrl }
          : imageUrl
            ? { kind: 'image', imageUrl }
            : undefined
      },
      market: {
        saleType,
        availability:
          saleType === 'NOT_FOR_SALE'
            ? 'NOT_LISTED'
            : saleType === 'FIXED' || saleType === 'AUCTION'
              ? 'LISTED'
              : undefined,
        price,
        endsAt,
        cta: buildPrimaryAction(
          canonical.platform,
          saleType === 'NOT_FOR_SALE' ? 'UNKNOWN' : (saleType as any),
          canonical.viewUrl
        )
      },
      links: {
        viewUrl: canonical.viewUrl,
        buyOrBidUrl: canonical.viewUrl
      }
    };

    return {
      patch
    };
  }
  private getFoundationMarketAddress() {
    return (
      env.getStringOrNull('FOUNDATION_MARKET_ADDRESS') ??
      '0xcDA72070E455bb31C7690a170224Ce43623d0B6f'
    ).toLowerCase();
  }
}
