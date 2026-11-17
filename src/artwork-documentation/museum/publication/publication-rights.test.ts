import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fc from 'fast-check';
import {
  canonicalRightsUri,
  iiifRightsUri,
  isIiifRegistryRightsUri,
  MUSEUM_RIGHTS_EXPRESSIONS,
  MUSEUM_RIGHTS_REGISTRY_SHA256,
  MUSEUM_RIGHTS_REGISTRY_VERSION
} from './publication-rights';

describe('Museum rights registry copy', () => {
  it('lists twenty canonical https URIs with unique ids', () => {
    expect(MUSEUM_RIGHTS_EXPRESSIONS).toHaveLength(20);
    expect(new Set(MUSEUM_RIGHTS_EXPRESSIONS.map((item) => item.id)).size).toBe(
      20
    );
    for (const item of MUSEUM_RIGHTS_EXPRESSIONS)
      expect(item.canonical_uri).toMatch(
        /^https:\/\/(creativecommons\.org\/(licenses|publicdomain)\/|rightsstatements\.org\/vocab\/).+\/$/
      );
  });
  it('accepts http or https registry forms and emits the http form IIIF requires', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...MUSEUM_RIGHTS_EXPRESSIONS.map((item) => item.canonical_uri)
        ),
        fc.boolean(),
        (canonical, http) => {
          const input = http ? iiifRightsUri(canonical) : canonical;
          expect(canonicalRightsUri(input)).toBe(canonical);
          expect(isIiifRegistryRightsUri(iiifRightsUri(canonical))).toBe(true);
          expect(isIiifRegistryRightsUri(canonical)).toBe(false);
        }
      )
    );
    expect(
      canonicalRightsUri('https://creativecommons.org/licenses/by/3.0/')
    ).toBeNull();
    expect(
      canonicalRightsUri('https://creativecommons.org/publicdomain/zero/1.0')
    ).toBeNull();
    expect(canonicalRightsUri(42)).toBeNull();
  });
  it('matches the checked-out museum registry when it is available locally', () => {
    const registry = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'museum',
      'docs',
      'rights',
      'registry.json'
    );
    if (!existsSync(registry)) return;
    const bytes = readFileSync(registry);
    const parsed = JSON.parse(bytes.toString('utf8')) as {
      registry_version: string;
      expressions: { id: string; canonical_uri: string | null }[];
    };
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      MUSEUM_RIGHTS_REGISTRY_SHA256
    );
    expect(parsed.registry_version).toBe(MUSEUM_RIGHTS_REGISTRY_VERSION);
    expect(
      parsed.expressions
        .filter((item) => item.canonical_uri)
        .map((item) => ({ id: item.id, canonical_uri: item.canonical_uri }))
    ).toEqual(MUSEUM_RIGHTS_EXPRESSIONS);
  });
});
