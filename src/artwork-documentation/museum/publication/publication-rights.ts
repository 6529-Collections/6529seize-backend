/**
 * Canonical rights URIs copied from the 6529 Museum rights expression registry.
 *
 * Source: 6529-museum `docs/rights/registry.json`
 *   registry_version 1.1.0, published 2026-08-05
 *   repository commit 3926d78
 *   file sha256 fd627ff3bb544fce3be247f222a5c2d8c98656b1753542654869965a8485c591
 *
 * Only expressions with a canonical URI are listed. "In copyright: no public
 * license stated" and "custom license" have no canonical URI and therefore
 * cannot be expressed as an IIIF `rights` value; such works are published
 * with a RightsStatements.org statement chosen by the publisher instead.
 *
 * The registry records the https form. The IIIF Presentation 3.0 schema
 * requires the http form for Creative Commons and RightsStatements.org URIs,
 * so `iiifRightsUri` returns that form for the manifest while
 * `canonicalRightsUri` accepts either scheme on input.
 */
export const MUSEUM_RIGHTS_REGISTRY_VERSION = '1.1.0';
export const MUSEUM_RIGHTS_REGISTRY_SHA256 =
  'fd627ff3bb544fce3be247f222a5c2d8c98656b1753542654869965a8485c591';

export const MUSEUM_RIGHTS_EXPRESSIONS: readonly {
  id: string;
  canonical_uri: string;
}[] = [
  {
    id: 'cc0-1.0',
    canonical_uri: 'https://creativecommons.org/publicdomain/zero/1.0/'
  },
  {
    id: 'cc-by-4.0',
    canonical_uri: 'https://creativecommons.org/licenses/by/4.0/'
  },
  {
    id: 'cc-by-sa-4.0',
    canonical_uri: 'https://creativecommons.org/licenses/by-sa/4.0/'
  },
  {
    id: 'cc-by-nd-4.0',
    canonical_uri: 'https://creativecommons.org/licenses/by-nd/4.0/'
  },
  {
    id: 'cc-by-nc-4.0',
    canonical_uri: 'https://creativecommons.org/licenses/by-nc/4.0/'
  },
  {
    id: 'cc-by-nc-sa-4.0',
    canonical_uri: 'https://creativecommons.org/licenses/by-nc-sa/4.0/'
  },
  {
    id: 'cc-by-nc-nd-4.0',
    canonical_uri: 'https://creativecommons.org/licenses/by-nc-nd/4.0/'
  },
  {
    id: 'public-domain-mark-1.0',
    canonical_uri: 'https://creativecommons.org/publicdomain/mark/1.0/'
  },
  {
    id: 'rightsstatements-inc',
    canonical_uri: 'https://rightsstatements.org/vocab/InC/1.0/'
  },
  {
    id: 'rightsstatements-inc-ow-eu',
    canonical_uri: 'https://rightsstatements.org/vocab/InC-OW-EU/1.0/'
  },
  {
    id: 'rightsstatements-inc-edu',
    canonical_uri: 'https://rightsstatements.org/vocab/InC-EDU/1.0/'
  },
  {
    id: 'rightsstatements-inc-nc',
    canonical_uri: 'https://rightsstatements.org/vocab/InC-NC/1.0/'
  },
  {
    id: 'rightsstatements-inc-ruu',
    canonical_uri: 'https://rightsstatements.org/vocab/InC-RUU/1.0/'
  },
  {
    id: 'rightsstatements-noc-cr',
    canonical_uri: 'https://rightsstatements.org/vocab/NoC-CR/1.0/'
  },
  {
    id: 'rightsstatements-noc-nc',
    canonical_uri: 'https://rightsstatements.org/vocab/NoC-NC/1.0/'
  },
  {
    id: 'rightsstatements-noc-oklr',
    canonical_uri: 'https://rightsstatements.org/vocab/NoC-OKLR/1.0/'
  },
  {
    id: 'rightsstatements-noc-us',
    canonical_uri: 'https://rightsstatements.org/vocab/NoC-US/1.0/'
  },
  {
    id: 'rightsstatements-cne',
    canonical_uri: 'https://rightsstatements.org/vocab/CNE/1.0/'
  },
  {
    id: 'rightsstatements-und',
    canonical_uri: 'https://rightsstatements.org/vocab/UND/1.0/'
  },
  {
    id: 'rightsstatements-nkc',
    canonical_uri: 'https://rightsstatements.org/vocab/NKC/1.0/'
  }
];

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
