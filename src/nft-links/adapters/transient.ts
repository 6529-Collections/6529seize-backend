import type { AdapterResult, PlatformAdapter } from './types';
import { Contract } from 'ethers';

import { fetchJsonWithTimeout } from '../lib/http';
import { normalizeMetadataUri } from '../lib/uri';
import { buildPrimaryAction } from '../lib/market';
import { formatTokenAmount, getErc20Meta, getProvider } from '../lib/onchain';
import { CanonicalLink } from '@/nft-links/types';
import { Time } from '@/time';
import { numbers } from '@/numbers';
import { env } from '@/env';
import { NULL_ADDRESS } from '@/constants';

/**
 * Transient Labs
 *
 * Token pages are JS-heavy; prefer onchain resolution:
 * - tokenURI for metadata/media
 * - Transient Labs Auction House contract for listing/auction state
 */

// Docs indicate Auction House v2.6.1 is deployed to supported chains at this address.
// Allow override for safety.
const DEFAULT_TL_AUCTION_HOUSE = '0x6f66b95a0c512f3497fb46660e0bc3b94b989f8d';

const ERC721_METADATA_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function name() view returns (string)'
];

// Listing struct shape from TLAuctionHouse (see verified source on Etherscan)
// tuple(
//   uint8 type_, bool zeroProtocolFee, address seller, address payoutReceiver,
//   address currencyAddress, uint256 openTime, uint256 reservePrice, uint256 buyNowPrice,
//   uint256 startTime, uint256 duration, address recipient, address highestBidder,
//   uint256 highestBid, uint256 id
// )
const TL_AUCTION_HOUSE_ABI = [
  'function getListing(address nftAddress, uint256 tokenId) view returns (tuple(uint8 type_, bool zeroProtocolFee, address seller, address payoutReceiver, address currencyAddress, uint256 openTime, uint256 reservePrice, uint256 buyNowPrice, uint256 startTime, uint256 duration, address recipient, address highestBidder, uint256 highestBid, uint256 id))'
];

type MetadataJson = Record<string, any>;

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function isZeroAddress(a: any): boolean {
  return String(a ?? '').toLowerCase() === NULL_ADDRESS;
}

export class TransientAdapter implements PlatformAdapter {
  canHandle(canonical: CanonicalLink): boolean {
    return (
      canonical.platform === 'TRANSIENT' &&
      canonical.identifiers.kind === 'TOKEN'
    );
  }

  async resolveFast(canonical: CanonicalLink): Promise<AdapterResult | null> {
    if (canonical.identifiers.kind !== 'TOKEN') return null;

    const { chain, contract, tokenId } = canonical.identifiers;
    const timeoutMs = env.getIntOrNull('TRANSIENT_TIMEOUT_MS') ?? 1800;

    const provider = getProvider(chain);

    // Token metadata
    const nft = new Contract(contract, ERC721_METADATA_ABI, provider);
    let tokenUri: string | undefined;
    let collectionName: string | undefined;
    try {
      [tokenUri, collectionName] = await Promise.all([
        nft.tokenURI(BigInt(tokenId)).catch(() => undefined),
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
    // Listing / auction state
    const auctionHouse = new Contract(
      this.getAuctionHouseAddress(),
      TL_AUCTION_HOUSE_ABI,
      provider
    );

    let listing: any;
    try {
      listing = await auctionHouse.getListing(contract, BigInt(tokenId));
    } catch {
      listing = null;
    }

    // Interpret listing
    let saleType: 'FIXED' | 'AUCTION' | 'NOT_FOR_SALE' | 'UNKNOWN' = 'UNKNOWN';
    let availability: 'LISTED' | 'NOT_LISTED' | 'SOLD' | undefined = undefined;
    let price: { amount: string; currency: string } | undefined;
    let endsAt: string | undefined;

    if (listing) {
      const typeNum = Number(listing.type_ ?? listing[0] ?? 0);
      const currencyAddress = String(
        listing.currencyAddress ?? listing[4] ?? NULL_ADDRESS
      );
      const reservePrice = BigInt(listing.reservePrice ?? listing[6] ?? 0);
      const buyNowPrice = BigInt(listing.buyNowPrice ?? listing[7] ?? 0);
      const startTime = BigInt(listing.startTime ?? listing[8] ?? 0);
      const duration = BigInt(listing.duration ?? listing[9] ?? 0);
      const highestBid = BigInt(listing.highestBid ?? listing[12] ?? 0);
      const highestBidder = String(
        listing.highestBidder ?? listing[11] ?? NULL_ADDRESS
      );

      if (typeNum === 0) {
        saleType = 'NOT_FOR_SALE';
        availability = 'NOT_LISTED';
      } else {
        availability = 'LISTED';

        // BUY_NOW is expected to be the last enum value. We avoid depending on exact numeric mapping by using the fields.
        const hasBuyNow = buyNowPrice > BigInt(0);
        const hasBid = !isZeroAddress(highestBidder) && highestBid > BigInt(0);

        if (hasBuyNow && !hasBid) {
          saleType = 'FIXED';
        } else {
          saleType = 'AUCTION';
        }

        const amountRaw =
          saleType === 'FIXED'
            ? buyNowPrice
            : highestBid > BigInt(0)
              ? highestBid
              : reservePrice;

        if (currencyAddress === NULL_ADDRESS) {
          price = { amount: formatTokenAmount(amountRaw, 18), currency: 'ETH' };
        } else {
          const meta = await getErc20Meta(provider, currencyAddress);
          price = {
            amount: formatTokenAmount(amountRaw, meta.decimals),
            currency: meta.symbol
          };
        }

        if (
          saleType === 'AUCTION' &&
          startTime > BigInt(0) &&
          duration > BigInt(0)
        ) {
          const endsAtSec = numbers.parseIntOrNull(startTime + duration);
          endsAt = endsAtSec
            ? Time.seconds(endsAtSec).toIsoDateTimeString()
            : undefined;
        }
      }
    }

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
        availability,
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

  private getAuctionHouseAddress() {
    return (
      env.getStringOrNull(`TRANSIENT_AUCTION_HOUSE_ADDRESS`) ??
      DEFAULT_TL_AUCTION_HOUSE
    ).toLowerCase();
  }
}
