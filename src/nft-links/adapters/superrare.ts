import type { AdapterResult, PlatformAdapter } from './types';
import { Contract, ZeroAddress } from 'ethers';

import { fetchJsonWithTimeout } from '../lib/http';
import { buildPrimaryAction } from '../lib/market';
import { formatTokenAmount, getErc20Meta, getProvider } from '../lib/onchain';
import { normalizeMetadataUri } from '../lib/uri';
import { CanonicalLink } from '@/nft-links/types';
import { numbers } from '@/numbers';
import { Time } from '@/time';
import { env } from '@/env';

/**
 * SuperRare
 *
 * We prefer a keyless, onchain-first integration:
 * - token metadata via ERC721 tokenURI
 * - market state via SuperRare Bazaar contract
 *
 * This avoids brittle HTML scraping and avoids depending on private / rate-limited APIs.
 */

const BAZAAR_ABI = [
  // Fixed-price sale price for a given target. Passing target=0x0 is the typical "public sale".
  'function getSalePrice(address _originContract, uint256 _tokenId, address _target) view returns (address seller, address currencyAddress, uint256 amount, address[] splitRecipients, uint8[] splitRatios)',

  // Auction config for a token.
  'function getAuctionDetails(address _originContract, uint256 _tokenId) view returns (address creatorAddress, uint256 creationTime, uint256 startingTime, uint256 lengthOfAuction, address currencyAddress, uint256 minimumBid, uint8 auctionType, address[] splitRecipients, uint8[] splitRatios)',

  // Public mapping accessor for current highest bid (if any).
  'function auctionBids(address _originContract, uint256 _tokenId) view returns (address bidder, address currencyAddress, uint256 amount, uint256 marketplaceFee)'
];

const ERC721_METADATA_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function name() view returns (string)'
];

type MetadataJson = Record<string, any>;

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

class SuperRareAdapter implements PlatformAdapter {
  canHandle(canonical: CanonicalLink): boolean {
    return (
      canonical.platform === 'SUPERRARE' &&
      canonical.identifiers.kind === 'TOKEN'
    );
  }

  async resolveFast(canonical: CanonicalLink): Promise<AdapterResult | null> {
    if (canonical.identifiers.kind !== 'TOKEN') return null;

    const { chain, contract, tokenId } = canonical.identifiers;
    const timeoutMs = env.getIntOrNull('SUPERRARE_TIMEOUT_MS') ?? 1800;

    const provider = getProvider(chain);
    const bazaar = new Contract(
      this.getSuperRareBazaarAddress(),
      BAZAAR_ABI,
      provider
    );
    const nft = new Contract(contract, ERC721_METADATA_ABI, provider);

    // --- Market state (best effort)
    let saleCurrency: string | undefined;
    let saleAmount: bigint | undefined;

    let auctionCreator: string | undefined;
    let auctionStart: bigint | undefined;
    let auctionLength: bigint | undefined;
    let auctionCurrency: string | undefined;
    let auctionMinBid: bigint | undefined;
    let currentBidAmount: bigint | undefined;

    // Sale price (target=0x0 => public)
    try {
      const res = await bazaar.getSalePrice(
        contract,
        BigInt(tokenId),
        ZeroAddress
      );
      const seller = String(res?.[0] ?? res?.seller ?? '');
      const currency = String(res?.[1] ?? res?.currencyAddress ?? ZeroAddress);
      const amount = BigInt(res?.[2] ?? res?.amount ?? 0);
      if (seller && seller !== ZeroAddress && amount > BigInt(0)) {
        saleCurrency = currency;
        saleAmount = amount;
      }
    } catch {
      // ignore
    }

    // Auction details
    try {
      const res = await bazaar.getAuctionDetails(contract, BigInt(tokenId));
      const creator = String(res?.[0] ?? res?.creatorAddress ?? '');
      const startingTime = BigInt(res?.[2] ?? res?.startingTime ?? 0);
      const length = BigInt(res?.[3] ?? res?.lengthOfAuction ?? 0);
      const currency = String(res?.[4] ?? res?.currencyAddress ?? ZeroAddress);
      const minBid = BigInt(res?.[5] ?? res?.minimumBid ?? 0);
      if (
        startingTime > BigInt(0) &&
        length > BigInt(0) &&
        minBid >= BigInt(0)
      ) {
        auctionCreator =
          creator && creator !== ZeroAddress ? creator : undefined;
        auctionStart = startingTime;
        auctionLength = length;
        auctionCurrency = currency;
        auctionMinBid = minBid;

        // current bid (optional)
        try {
          const bidRes = await bazaar.auctionBids(contract, BigInt(tokenId));
          const amt = BigInt(bidRes?.[2] ?? bidRes?.amount ?? 0);
          if (amt > BigInt(0)) currentBidAmount = amt;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    // Interpret state
    let saleType: 'FIXED' | 'AUCTION' | 'NOT_FOR_SALE' | 'UNKNOWN';
    let price: { amount: string; currency: string } | undefined;
    let endsAt: string | undefined;

    if (saleAmount && saleCurrency) {
      saleType = 'FIXED';
      if (saleCurrency === ZeroAddress) {
        price = { amount: formatTokenAmount(saleAmount, 18), currency: 'ETH' };
      } else {
        const meta = await getErc20Meta(provider, saleCurrency);
        price = {
          amount: formatTokenAmount(saleAmount, meta.decimals),
          currency: meta.symbol
        };
      }
    } else if (
      auctionStart &&
      auctionLength &&
      auctionCurrency &&
      auctionMinBid != null
    ) {
      saleType = 'AUCTION';
      const effectiveAmount =
        currentBidAmount && currentBidAmount > BigInt(0)
          ? currentBidAmount
          : auctionMinBid;
      if (auctionCurrency === ZeroAddress) {
        price = {
          amount: formatTokenAmount(effectiveAmount, 18),
          currency: 'ETH'
        };
      } else {
        const meta = await getErc20Meta(provider, auctionCurrency);
        price = {
          amount: formatTokenAmount(effectiveAmount, meta.decimals),
          currency: meta.symbol
        };
      }
      endsAt = Time.seconds(
        numbers.parseNumberOrThrow(auctionStart + auctionLength)
      ).toIsoString();
    } else {
      saleType = 'NOT_FOR_SALE';
    }

    // --- Metadata
    const [tokenUri, collectionName] = await Promise.all([
      nft.tokenURI(BigInt(tokenId)),
      nft.name().catch(() => undefined)
    ]);

    let meta: MetadataJson | undefined;
    if (tokenUri) {
      const resolved = normalizeMetadataUri(tokenUri);
      if (resolved) {
        meta = await fetchJsonWithTimeout<MetadataJson>(resolved, {
          timeoutMs
        });
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
        creator: auctionCreator ? { address: auctionCreator } : undefined,
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
          saleType === 'FIXED' || saleType === 'AUCTION'
            ? 'LISTED'
            : 'NOT_LISTED',
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
  private getSuperRareBazaarAddress() {
    return (
      env.getStringOrNull(`SUPERRARE_BAZAAR_ADDRESS`) ??
      '0x6D7c44773C52D396F43c2D511B81aa168E9a7a42'
    ).toLowerCase();
  }
}

export default SuperRareAdapter;
