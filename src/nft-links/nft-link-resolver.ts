import type { CanonicalLink, NormalizedNftCard } from './types';
import { validateLinkUrl } from './nft-link-resolver.validator';
import { getAdapterFor } from './adapters/registry';
import { buildPrimaryAction } from './lib/market';
import { fetchTextWithTimeout } from './lib/http';
import { extractOg } from './lib/og';
import { NftLinkResolverValidationError } from '@/nft-links/nft-link-resolver-validation.error';
import { formatTokenAmount } from '@/nft-links/lib/onchain';
import { RequestContext } from '@/request.context';
import { env } from '@/env';

export class NftLinkResolver {
  private isOgFetchAllowed(viewUrl: string): boolean {
    try {
      const u = new URL(viewUrl);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (
        [
          'superrare.com',
          'opensea.io',
          'testnets.opensea.io',
          'foundation.app',
          'transient.xyz',
          'lab.transient.xyz'
        ].includes(host)
      )
        return true;
      // Manifold-owned domains only; do NOT OG-fetch arbitrary CNAMES.
      return (
        host === 'app.manifold.xyz' ||
        host === 'manifold.xyz' ||
        host.endsWith('.manifold.xyz')
      );
    } catch {
      return false;
    }
  }

  private deepMerge<T extends Record<string, any>>(
    base: T,
    patch: Partial<T>
  ): T {
    const out: any = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        typeof out[k] === 'object' &&
        out[k] !== null &&
        !Array.isArray(out[k])
      ) {
        out[k] = this.deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private buildBaseCard(canonical: CanonicalLink): NormalizedNftCard {
    const ids: any = canonical.identifiers as any;
    return {
      identifier: canonical,

      asset: {
        contract:
          ids.kind === 'TOKEN' || ids.kind === 'CONTRACT_ONLY'
            ? ids.contract
            : undefined,
        tokenId: ids.kind === 'TOKEN' ? ids.tokenId : undefined
      },

      market: {
        saleType: 'UNKNOWN',
        cta: buildPrimaryAction(
          canonical.platform,
          'UNKNOWN',
          canonical.viewUrl
        )
      },

      links: {
        viewUrl: canonical.viewUrl,
        buyOrBidUrl: canonical.viewUrl
      }
    };
  }

  private async enrichWithOgIfMissing(
    card: NormalizedNftCard,
    canonical: CanonicalLink
  ): Promise<{
    patch: Partial<NormalizedNftCard>;
  } | null> {
    const needsTitle = !card.asset.title;
    const needsImage =
      !card.asset.media?.imageUrl && !card.asset.media?.animationUrl;
    if (!needsTitle && !needsImage) return null;

    if (!this.isOgFetchAllowed(canonical.viewUrl)) return null;
    const timeoutMs = env.getIntOrNull('OG_TIMEOUT_MS') ?? 5000;
    const html = await fetchTextWithTimeout(canonical.viewUrl, { timeoutMs });

    const og = extractOg(html);
    const fallbackPriceAmount =
      !card.market.price && og.lastPrice
        ? formatTokenAmount(BigInt(og.lastPrice), 18)
        : undefined;

    const patch: any = {
      asset: {
        title: needsTitle ? og.title : undefined,
        description: card.asset.description ? undefined : og.description,
        media:
          needsImage && og.image
            ? { kind: 'image', imageUrl: og.image }
            : undefined
      },
      market: fallbackPriceAmount
        ? {
            price: {
              amount: fallbackPriceAmount,
              currency: 'ETH'
            }
          }
        : undefined
    };

    return {
      patch
    };
  }

  public async resolve(
    url: string,
    ctx: RequestContext
  ): Promise<NormalizedNftCard> {
    try {
      ctx.timer?.start(`${this.constructor.name}->resolve`);
      const canonical = validateLinkUrl(url);
      let card = this.buildBaseCard(canonical);

      // If needs network verification, let caller decide to enforce it.
      const adapter = getAdapterFor(canonical);
      if (adapter) {
        const res = await adapter.resolveFast(canonical);
        if (res?.patch) {
          card = this.deepMerge(card, res.patch);
        }
      }

      // OG fallback (allowlisted domains only; our validator ensures this)
      const ogRes = await this.enrichWithOgIfMissing(card, canonical);
      if (ogRes) {
        card = this.deepMerge(card, ogRes.patch);
      }

      if (!card.asset.media) {
        throw new NftLinkResolverValidationError(
          `Unable to enrich ${url}. Missing media.`
        );
      }

      return card;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->resolve`);
    }
  }
}

export const nftLinkResolver = new NftLinkResolver();
