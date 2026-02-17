import type { AdapterResult, PlatformAdapter } from './types';
import { fetchJsonWithTimeout, fetchTextWithTimeout } from '../lib/http';
import { buildPrimaryAction } from '../lib/market';
import { numbers } from '@/numbers';
import { formatTokenAmount } from '@/nft-links/lib/onchain';
import { CanonicalLink } from '@/nft-links/types';
import { env } from '@/env';

type AnyObj = Record<string, any>;

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function safeExtractInstanceIdFromHtml(html: string): string | undefined {
  // Prefer very specific patterns to avoid false positives.
  const patterns: RegExp[] = [
    /public\/instance\/data\?id=(\d{6,12})/i,
    /"instanceId"\s*:\s*"?(\d{6,12})"?/i,
    /"claimId"\s*:\s*"?(\d{6,12})"?/i,
    /\bid\s*=\s*"(\d{6,12})"/i
  ];
  for (const p of patterns) {
    const m = p.exec(html);
    if (m?.at(1)) return m[1];
  }
  return undefined;
}

function isSafeManifoldHost(viewUrl: string): boolean {
  try {
    const u = new URL(viewUrl);
    const h = u.hostname.toLowerCase();
    return (
      h === 'app.manifold.xyz' ||
      h === 'manifold.xyz' ||
      h.endsWith('.manifold.xyz')
    );
  } catch {
    return false;
  }
}

export class ManifoldAdapter implements PlatformAdapter {
  canHandle(canonical: CanonicalLink): boolean {
    return canonical.platform === 'MANIFOLD';
  }

  async resolveFast(canonical: CanonicalLink): Promise<AdapterResult | null> {
    const timeoutMs = env.getIntOrNull('MANIFOLD_TIMEOUT_MS') ?? 1200;
    const base =
      env.getStringOrNull('MANIFOLD_INSTANCE_DATA_URL') ??
      'https://apps.api.manifoldxyz.dev/public/instance/data';

    const ids =
      canonical.identifiers.kind === 'MANIFOLD_CLAIM'
        ? canonical.identifiers
        : null;
    if (!ids) return null;

    // If we don't have an instanceId, but we have a slug, try to extract the id from the official
    // Manifold page HTML (safe host only). Manifold's slug-based public API has been reported
    // as deprecated; id-based is the most reliable.
    let instanceId: string | undefined = ids.instanceId;
    if (
      !instanceId &&
      ids.instanceSlug &&
      isSafeManifoldHost(canonical.viewUrl)
    ) {
      try {
        const html = await fetchTextWithTimeout(canonical.viewUrl, {
          timeoutMs,
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; 6529-link-resolver/0.7)',
            accept: 'text/html,application/xhtml+xml'
          }
        });
        instanceId = safeExtractInstanceIdFromHtml(html);
      } catch {
        // ignore
      }
    }

    // If we have an instanceId, verify via instance-data endpoint.
    let data: AnyObj | undefined;
    if (!instanceId) {
      throw new Error('Cant resolve Manifold instance ID');
    }

    {
      const url = `${base}?id=${encodeURIComponent(instanceId)}`;
      try {
        data = await fetchJsonWithTimeout<AnyObj>(url, {
          timeoutMs,
          headers: {
            // Some Manifold endpoints are protected by bot rules; be explicit.
            'user-agent': 'Mozilla/5.0 (compatible; 6529-link-resolver/0.7)',
            accept: 'application/json'
          }
        });
      } catch {
        throw new Error('Unable to fetch from ' + url);
      }
    }

    // Very loose extraction; exact shape varies.
    const title = pick<string>(
      data?.name,
      data?.title,
      data?.instance?.name,
      data?.instance?.title,
      data?.data?.name,
      data?.data?.title
    );

    const imageUrl = pick<string>(
      data?.image,
      data?.imageUrl,
      data?.data?.image,
      data?.data?.imageUrl
    );

    const description = pick<string>(
      data?.description,
      data?.data?.description
    );

    const priceAmount = pick<any>(
      data?.price,
      data?.data?.price,
      data?.mintPrice,
      data?.data?.mintPrice,
      data?.publicData?.mintPrice?.value
    );

    const priceCurrency = pick<any>(
      data?.currency,
      data?.data?.currency,
      data?.currencySymbol,
      data?.data?.currencySymbol,
      data?.publicData?.mintPrice?.currency
    );

    const priceDecimals =
      numbers.parseIntOrNull(
        pick<any>(
          data?.decimals,
          data?.data?.decimals,
          data?.publicData?.mintPrice?.decimals
        )
      ) ?? 0;
    // Claims are usually CLAIM sale type; price may require onchain reads.
    const saleType = 'CLAIM' as const;
    const patch: any = {
      asset: {
        title,
        description,
        media: imageUrl ? { kind: 'image', imageUrl } : undefined
      },
      market: {
        saleType,
        price:
          priceAmount != null && priceCurrency != null
            ? {
                amount: formatTokenAmount(BigInt(priceAmount), priceDecimals),
                currency: String(priceCurrency)
              }
            : undefined,
        cta: buildPrimaryAction(canonical.platform, saleType, canonical.viewUrl)
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
}
