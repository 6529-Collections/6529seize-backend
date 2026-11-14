import registry from './publication-rights.registry.json';

/**
 * Canonical rights URIs copied from the 6529 Museum rights expression registry.
 *
 * The data lives in `publication-rights.registry.json`, a verbatim subset of
 * museum `docs/rights/registry.json` (registry_version 1.1.0, published
 * 2026-08-05, repository commit 3926d78, file sha256
 * fd627ff3bb544fce3be247f222a5c2d8c98656b1753542654869965a8485c591).
 *
 * The registry records the https form. The IIIF Presentation 3.0 schema
 * requires the http form for Creative Commons and RightsStatements.org URIs,
 * so `iiifRightsUri` returns that form for the manifest while
 * `canonicalRightsUri` accepts either scheme on input.
 */
export const MUSEUM_RIGHTS_REGISTRY_VERSION: string = registry.registry_version;
export const MUSEUM_RIGHTS_REGISTRY_SHA256: string = registry.source_sha256;

export interface MuseumRightsExpression {
  id: string;
  canonical_uri: string;
}
export const MUSEUM_RIGHTS_EXPRESSIONS: readonly MuseumRightsExpression[] =
  registry.expressions.map(({ id, canonical_uri }) => ({ id, canonical_uri }));

const byHttpsUri = new Map(
  MUSEUM_RIGHTS_EXPRESSIONS.map((item) => [item.canonical_uri, item])
);

/** The registry's https canonical URI for an http or https registry URI, else null. */
export function canonicalRightsUri(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const https = value.startsWith('http://')
    ? `https://${value.slice('http://'.length)}`
    : value;
  return byHttpsUri.has(https) ? https : null;
}

/** The http form the IIIF Presentation 3.0 schema requires for `rights`. */
export function iiifRightsUri(canonical: string): string {
  return `http://${canonical.slice('https://'.length)}`;
}

/** True when a manifest `rights` value is the http form of a registry URI. */
export function isIiifRegistryRightsUri(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith('http://') &&
    canonicalRightsUri(value) !== null
  );
}
