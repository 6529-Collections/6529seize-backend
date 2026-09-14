import type { AdapterResult, PlatformAdapter } from './types';
import { fetchJsonWithTimeout, fetchTextWithTimeout } from '../lib/http';
import { buildPrimaryAction } from '../lib/market';
import { numbers } from '@/numbers';
import { formatTokenAmount } from '@/nft-links/lib/onchain';
import { CanonicalLink, NormalizedNftCard } from '@/nft-links/types';
import { env } from '@/env';
import { requiredNftPage404 } from '../nft-link-page-retry';
import { normalizeMetadataUri } from '../lib/uri';

type AnyObj = Record<string, any>;

function pick<T>(...vals: Array<T | undefined | null>): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseInstanceId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    ? value
    : undefined;
}

function assertMatchingInstance(
  data: unknown,
  instanceId: string,
  requireId: boolean
): void {
  if (!isRecord(data)) {
    throw new Error('Invalid Manifold instance response');
  }
  const returnedId = responseInstanceId(data.id);
  if (returnedId === undefined ? requireId : returnedId !== instanceId) {
    throw new Error('Invalid Manifold instance response');
  }
}

function metadataText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function selectedTokenImage(value: unknown): string | undefined {
  const text = metadataText(value);
  if (!text) return undefined;
  try {
    const normalized = normalizeMetadataUri(text);
    if (!normalized || !/^https?:\/\//i.test(normalized)) return undefined;
    const url = new URL(normalized);
    if (url.username || url.password) return undefined;
    // Download-time DNS/IP, redirect and size checks remain in the preview pipeline.
    return url.toString();
  } catch {
    return undefined;
  }
}

function resolveSelectedToken(
  token: unknown,
  canonical: CanonicalLink
): AdapterResult {
  if (!isRecord(token)) {
    throw new Error('Invalid Manifold selected token');
  }
  const imageUrl = selectedTokenImage(token.image);
  return withUnknownSale(
    {
      title: metadataText(token.name),
      description: metadataText(token.description),
      media: imageUrl ? { kind: 'image', imageUrl } : undefined
    },
    canonical
  );
}

function withUnknownSale(
  asset: NormalizedNftCard['asset'],
  canonical: CanonicalLink
): AdapterResult {
  return {
    patch: {
      asset,
      // Listing metadata is not proof of a claim, live price or availability.
      market: {
        saleType: 'UNKNOWN',
        cta: buildPrimaryAction(
          canonical.platform,
          'UNKNOWN',
          canonical.viewUrl
        )
      },
      links: { viewUrl: canonical.viewUrl, buyOrBidUrl: canonical.viewUrl }
    }
  };
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

function resolveInstanceMetadata(
  data: AnyObj | undefined,
  instanceId: string,
  canonical: CanonicalLink
): AdapterResult {
  const publicData: unknown = data?.publicData;
  const hasSelectedToken =
    isRecord(publicData) && 'selectedToken' in publicData;
  // New token metadata requires a positive ID binding. Legacy responses may omit
  // an ID; keep their extraction compatible, but never accept a known mismatch.
  assertMatchingInstance(data, instanceId, hasSelectedToken);
  if (isRecord(publicData) && 'selectedToken' in publicData) {
    return resolveSelectedToken(publicData.selectedToken, canonical);
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

  const description = pick<string>(data?.description, data?.data?.description);

  if (isRecord(publicData) && 'listingType' in publicData) {
    return withUnknownSale(
      {
        title,
        description,
        media: imageUrl ? { kind: 'image', imageUrl } : undefined
      },
      canonical
    );
  }

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
      } catch (error) {
        const pageFailure = requiredNftPage404(error, canonical);
        if (pageFailure) throw pageFailure;
        // Other page failures retain the existing resolution/retry behavior.
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

    return resolveInstanceMetadata(data, instanceId, canonical);
  }
}
