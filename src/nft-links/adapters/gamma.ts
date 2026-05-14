import type {
  AdapterResult,
  PlatformAdapter
} from '@/nft-links/adapters/types';
import { buildPrimaryAction } from '@/nft-links/lib/market';
import { fetchTextWithTimeout } from '@/nft-links/lib/http';
import { extractOg } from '@/nft-links/lib/og';
import { CanonicalLink } from '@/nft-links/types';
import { env } from '@/env';
import { CustomApiCompliantException } from '@/exceptions';

type GammaIdentifier =
  | { kind: 'ordinal'; inscriptionId: string }
  | { kind: 'collection'; collectionSlug: string; tokenId: string }
  | null;

const HTML_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#34;': '"',
  '&amp;': '&',
  '&#38;': '&',
  '&lt;': '<',
  '&#60;': '<',
  '&gt;': '>',
  '&#62;': '>'
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(quot|amp|lt|gt|#34|#38|#60|#62);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractJsonLdBlocks(html: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const scriptRegex =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html))) {
    const rawJson = decodeHtmlEntities(match[1] ?? '').trim();
    if (!rawJson) continue;
    try {
      const parsed: unknown = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        blocks.push(...parsed.filter(isRecord));
      } else if (isRecord(parsed)) {
        if (Array.isArray(parsed['@graph'])) {
          blocks.push(...parsed['@graph'].filter(isRecord));
        }
        blocks.push(parsed);
      }
    } catch {
      // Gamma pages can include partial/non-NFT JSON-LD; ignore malformed blocks.
    }
  }

  return blocks;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function getJsonLdImage(block: Record<string, unknown>): string | undefined {
  const image = block.image;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    return firstString(...image);
  }
  if (isRecord(image)) {
    return firstString(image.url, image.contentUrl);
  }
  return undefined;
}

function hasGammaMetadata(
  title: string | undefined,
  description: string | undefined,
  imageUrl: string | undefined
): boolean {
  return !!(title || description || imageUrl);
}

function slugToName(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseGammaIdentifier(canonical: CanonicalLink): GammaIdentifier {
  if (canonical.identifiers.kind !== 'URL_ONLY') return null;
  const customId = canonical.identifiers.customId;
  if (!customId) return null;

  const ordinalMatch = /^ordinal:(.+)$/.exec(customId);
  if (ordinalMatch?.[1]) {
    return { kind: 'ordinal', inscriptionId: ordinalMatch[1] };
  }

  const collectionMatch = /^collection:([^:]+):(\d+)$/.exec(customId);
  if (collectionMatch?.[1] && collectionMatch?.[2]) {
    return {
      kind: 'collection',
      collectionSlug: collectionMatch[1],
      tokenId: collectionMatch[2]
    };
  }

  return null;
}

export class GammaAdapter implements PlatformAdapter {
  canHandle(canonical: CanonicalLink): boolean {
    return canonical.platform === 'GAMMA';
  }

  async resolveFast(canonical: CanonicalLink): Promise<AdapterResult | null> {
    const timeoutMs = env.getIntOrNull('GAMMA_TIMEOUT_MS') ?? 1800;
    const html = await fetchTextWithTimeout(canonical.viewUrl, {
      timeoutMs,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; 6529-link-resolver/0.7)',
        accept: 'text/html,application/xhtml+xml'
      }
    });

    const og = extractOg(html);
    const jsonLd = extractJsonLdBlocks(html);
    const primaryJsonLd = jsonLd.find(
      (block) => getJsonLdImage(block) || firstString(block.name)
    );
    const identifier = parseGammaIdentifier(canonical);

    const title = firstString(og.title, primaryJsonLd?.name);
    const description = firstString(og.description, primaryJsonLd?.description);
    const imageUrl = firstString(
      og.image,
      primaryJsonLd ? getJsonLdImage(primaryJsonLd) : undefined
    );

    if (!primaryJsonLd || !hasGammaMetadata(title, description, imageUrl)) {
      throw new CustomApiCompliantException(
        502,
        `Unable to extract Gamma metadata from ${canonical.viewUrl}`
      );
    }

    const patch: Partial<AdapterResult['patch']> = {
      asset: {
        title,
        description,
        collection:
          identifier?.kind === 'collection'
            ? { name: slugToName(identifier.collectionSlug) }
            : undefined,
        tokenId:
          identifier?.kind === 'collection' ? identifier.tokenId : undefined,
        media: imageUrl ? { kind: 'image', imageUrl } : undefined
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

    return { patch };
  }
}

export default GammaAdapter;
