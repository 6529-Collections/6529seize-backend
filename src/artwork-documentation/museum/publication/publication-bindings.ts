import { StoredAsset } from '../../assets/artwork-assets.types';
import { IiifResource } from '../export/iiif-resources';
import { PublicationBindings, reject } from './publication.types';

/** Conservative path segment: the museum common id pattern without a length floor. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function parseHttps(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname
  )
    return null;
  return url;
}

/** Validates an https base URL under a path of conservative identifiers; returns it without a trailing slash. */
export function publicationBase(value: unknown): string {
  const url = parseHttps(value);
  if (!url || url.search)
    reject(
      'INVALID_BASE_URL',
      'The publication base must be an https URL without query, fragment or credentials.'
    );
  const segments = url.pathname.split('/').filter((part) => part !== '');
  if (!segments.length || !segments.every((part) => SEGMENT.test(part)))
    reject(
      'INVALID_BASE_URL',
      'The publication base path must contain only conservative identifiers.'
    );
  return `${url.origin}/${segments.join('/')}`;
}

/** Validates a stable public https media URL and returns it unchanged. */
export function publicMediaUrl(assetId: string, value: unknown): string {
  const url = parseHttps(value);
  if (!url)
    reject(
      'INVALID_MEDIA_URL',
      'Every selected asset needs an https media URL without fragment or credentials.',
      assetId
    );
  return value as string;
}

export interface ResolvedBindings {
  base: string;
  homepage: string;
  media: Map<string, string>;
}

export function resolveBindings(
  selected: StoredAsset[],
  bindings: PublicationBindings
): ResolvedBindings {
  const base = publicationBase(bindings?.base_url);
  const homepage =
    bindings.homepage_url === undefined
      ? base
      : (() => {
          const url = parseHttps(bindings.homepage_url);
          if (!url)
            reject(
              'INVALID_HOMEPAGE_URL',
              'The homepage must be an https URL without fragment or credentials.'
            );
          return bindings.homepage_url as string;
        })();
  const supplied =
    bindings.media && typeof bindings.media === 'object' ? bindings.media : {};
  const selectedIds = new Set(selected.map((asset) => asset.id));
  for (const id of Object.keys(supplied))
    if (!selectedIds.has(id))
      reject(
        'BINDING_NOT_SELECTED',
        'A media binding names an asset that is not in the approved selection.',
        id
      );
  const media = new Map<string, string>();
  for (const asset of selected) {
    if (!Object.prototype.hasOwnProperty.call(supplied, asset.id))
      reject(
        'MISSING_MEDIA_BINDING',
        'Every selected asset needs a public media URL binding.',
        asset.id
      );
    media.set(asset.id, publicMediaUrl(asset.id, supplied[asset.id]));
  }
  return { base, homepage, media };
}

/** Rewrites every draft URL in the manifest onto the publication base and the bound media URLs. */
export function rebaseManifest(
  value: IiifResource,
  draftPrefix: string,
  bindings: ResolvedBindings
): IiifResource {
  const originals = `${draftPrefix}/originals/`;
  const rewrite = (text: string): string => {
    if (text.startsWith(originals)) {
      const rest = text.slice(originals.length);
      const hash = rest.indexOf('#');
      const assetId = hash === -1 ? rest : rest.slice(0, hash);
      const bound = bindings.media.get(assetId);
      if (bound === undefined) return text;
      return hash === -1 ? bound : bound + rest.slice(hash);
    }
    if (text === draftPrefix || text.startsWith(`${draftPrefix}/`))
      return bindings.base + text.slice(draftPrefix.length);
    return text;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return rewrite(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) result[key] = walk(item);
      return result;
    }
    return node;
  };
  return walk(value) as IiifResource;
}

/** The asset id named by a draft original URL (with or without a fragment), else null. */
export function draftAssetId(
  value: unknown,
  draftPrefix: string
): string | null {
  const originals = `${draftPrefix}/originals/`;
  if (typeof value !== 'string' || !value.startsWith(originals)) return null;
  const rest = value.slice(originals.length);
  const hash = rest.indexOf('#');
  return hash === -1 ? rest : rest.slice(0, hash);
}
