import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fc from 'fast-check';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { digest, normalizeJson } from '../../artwork-documentation.validation';
import { dossierSourceHash } from '../export/dossier';
import { corpusId } from '../fixtures/museum-corpus';
import {
  PUBLICATION_CASES,
  PUBLICATION_RIGHTS_URI,
  publicationFixture
} from '../fixtures/publication-fixtures';
import { compilePublication } from './publication-compiler';
import {
  PublicationInput,
  PublicationRejectedError
} from './publication.types';

const GOLDENS = join(__dirname, '..', 'fixtures', 'publication');
const canonical = (value: unknown) => canonicalizeJson(normalizeJson(value));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const text = (value: unknown) => JSON.stringify(value);

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Shuffles object key order recursively; arrays keep their order. */
function shuffleKeys(value: unknown, random: () => number): unknown {
  if (Array.isArray(value))
    return value.map((item) => shuffleKeys(item, random));
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  const result: Record<string, unknown> = {};
  for (const key of keys)
    result[key] = shuffleKeys((value as Record<string, unknown>)[key], random);
  return result;
}
function expectRejection(input: PublicationInput, code: string) {
  let error: unknown;
  try {
    compilePublication(input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PublicationRejectedError);
  expect((error as PublicationRejectedError).code).toBe(code);
}

describe('Museum publication compiler', () => {
  it.each(PUBLICATION_CASES)(
    'compiles the %s fixture into a structurally valid manifest matching its committed golden',
    (name) => {
      const { input } = publicationFixture(name);
      const compiled = compilePublication(input);
      expect(compiled.validation).toEqual({ ok: true, errors: [] });
      expect(compiled.source_sha256).toBe(input.source_sha256);
      expect(compiled.manifest_sha256).toBe(digest(compiled.manifest));
      expect(Object.keys(compiled.manifest)[0]).toBe('@context');
      expect(compiled.manifest.id).toBe(`${input.bindings.base_url}/manifest`);
      expect(compiled.manifest.rights).toBe(
        'http://creativecommons.org/publicdomain/zero/1.0/'
      );
      expect(compiled.manifest.requiredStatement).toEqual({
        label: { en: ['Credit'] },
        value: { en: ['Synthetic Test Artist, Test Work, 2026. CC0 1.0.'] }
      });
      expect(compiled.manifest.provider).toEqual([
        {
          id: 'https://6529.io/museum',
          type: 'Agent',
          label: { en: ['6529 Museum'] }
        }
      ]);
      expect(compiled.manifest.seeAlso).toContainEqual(
        expect.objectContaining({
          id: `${input.bindings.base_url}/source`,
          type: 'Dataset',
          format: 'application/json'
        })
      );
      const serialized = text(compiled.manifest);
      expect(serialized).not.toContain('example.invalid');
      for (const url of Object.values(input.bindings.media))
        expect(serialized).toContain(url);
      expect(serialized).not.toContain('private-test');
      expect(serialized).not.toContain('object_key');
      const golden = JSON.parse(
        readFileSync(join(GOLDENS, `${name}.json`), 'utf8')
      );
      expect(compiled.manifest).toEqual(golden);
      const digests = JSON.parse(
        readFileSync(join(GOLDENS, 'digests.json'), 'utf8')
      );
      expect(digests[name]).toEqual({
        source_sha256: compiled.source_sha256,
        manifest_sha256: compiled.manifest_sha256,
        input_digest: compiled.transformation.input_digest
      });
    }
  );

  it('paints a still image with a thumbnail and keeps only selected originals as renderings', () => {
    const { input } = publicationFixture('still-image');
    const compiled = compilePublication(input);
    const canvases = compiled.manifest.items as Record<string, unknown>[];
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 10, height: 10 });
    expect(compiled.manifest.thumbnail).toEqual([
      expect.objectContaining({ type: 'Image', width: 10, height: 10 })
    ]);
    expect(compiled.manifest.rendering).toHaveLength(1);
    expect(compiled.manifest.metadata).toContainEqual({
      label: { en: ['Resource role'] },
      value: { en: ['synthetic.svg — Authorized manifestation'] }
    });
    expect(text(compiled.manifest)).not.toContain('Documentation surrogate');
  });

  it('paints timed media with a duration and no thumbnail', () => {
    const { input } = publicationFixture('timed-media');
    const compiled = compilePublication(input);
    const canvases = compiled.manifest.items as Record<string, unknown>[];
    expect(canvases[0]).toMatchObject({ width: 64, height: 64, duration: 1 });
    expect(compiled.manifest).not.toHaveProperty('thumbnail');
  });

  it('keeps declared multipart scenes in order, labels the surrogate scene and lists every role', () => {
    const { input } = publicationFixture('multipart');
    const compiled = compilePublication(input);
    const canvases = compiled.manifest.items as Record<string, unknown>[];
    expect(canvases.map((canvas) => canvas.id)).toEqual([
      `${input.bindings.base_url}/canvas/${corpusId(700)}`,
      `${input.bindings.base_url}/canvas/${corpusId(702)}`
    ]);
    expect(canvases[0].label).toEqual({
      en: ['Installation view — documentation surrogate']
    });
    expect(canvases[0].metadata).toContainEqual({
      label: { en: ['Documentation surrogate'] },
      value: {
        en: [
          'This canvas presents a documentation surrogate: a recorded viewing of the work, not the complete work.'
        ]
      }
    });
    expect(canvases[1].label).toEqual({ none: ['Sound component'] });
    expect(canvases[1]).toMatchObject({ duration: 1 });
    const roles = (
      compiled.manifest.metadata as {
        label: { en: string[] };
        value: { en: string[] };
      }[]
    )
      .filter((item) => item.label.en[0] === 'Resource role')
      .map((item) => item.value.en[0]);
    expect(roles).toEqual([
      'synthetic-installation.zip — Preservation master',
      'synthetic-pixel.png — Documentation surrogate (not the complete work)',
      'synthetic-silence.wav — Authorized manifestation',
      'synthetic-scene.gltf — Technical model'
    ]);
    expect(compiled.manifest.rendering).toHaveLength(4);
  });

  it('never presents a still of a generative work as the complete work', () => {
    const { input } = publicationFixture('generative-surrogate');
    const compiled = compilePublication(input);
    const canvases = compiled.manifest.items as Record<string, unknown>[];
    expect(canvases).toHaveLength(1);
    expect(canvases[0].label).toEqual({
      en: [
        'reference-capture.png — documentation surrogate (captured 2026-09-12)'
      ]
    });
    expect(canvases[0].rendering).toEqual([
      {
        id: 'https://generator.example/works/synthetic-seed-1',
        type: 'Text',
        label: {
          en: ['Live upstream realization (mutable URL, not byte-stable)']
        },
        format: 'text/html'
      }
    ]);
    expect(compiled.manifest.rendering).toContainEqual(
      expect.objectContaining({
        id: 'https://generator.example/works/synthetic-seed-1'
      })
    );
    expect(compiled.manifest.metadata).toContainEqual(
      expect.objectContaining({ label: { en: ['Live work'] } })
    );
    expect(compiled.manifest.metadata).toContainEqual(
      expect.objectContaining({ label: { en: ['Documentation surrogate'] } })
    );
    const serialized = text(compiled.manifest);
    expect(serialized).not.toContain('<!doctype');
    expect(serialized).not.toContain('<script');
    const painted = JSON.stringify(canvases[0].items);
    expect(painted).not.toContain(input.bindings.media[corpusId(100)]);
    expectRejection(
      {
        ...input,
        roles: { ...input.roles, [corpusId(110)]: 'authorized_manifestation' }
      },
      'INCONSISTENT_ROLE'
    );
  });

  it('is deterministic for the same input and for permuted key and selection order', () => {
    for (const name of PUBLICATION_CASES) {
      const first = compilePublication(publicationFixture(name).input);
      const second = compilePublication(publicationFixture(name).input);
      expect(canonical(second)).toBe(canonical(first));
    }
    const { input } = publicationFixture('multipart');
    const reference = compilePublication(input);
    const ids = input.selection.asset_ids;
    fc.assert(
      fc.property(
        fc.integer(),
        fc.shuffledSubarray(ids, {
          minLength: ids.length,
          maxLength: ids.length
        }),
        (seed, order) => {
          const permuted = shuffleKeys(
            { ...clone(input), selection: { asset_ids: order } },
            mulberry32(seed)
          ) as PublicationInput;
          const compiled = compilePublication(permuted);
          expect(canonical(compiled)).toBe(canonical(reference));
          expect(compiled.manifest_sha256).toBe(reference.manifest_sha256);
          expect(compiled.transformation.input_digest).toBe(
            reference.transformation.input_digest
          );
          expect(text(compiled.manifest)).toBe(text(reference.manifest));
        }
      ),
      { numRuns: 25 }
    );
    expect(
      compilePublication({ ...input, produced_at: '2026-11-09T00:00:00Z' })
        .transformation.produced_at
    ).toBe('2026-11-09T00:00:00Z');
  });

  it('rejects a private asset, a hash mismatch, a missing binding, an unknown role, a missing rights URI and an invalid base URL', () => {
    const { input } = publicationFixture('still-image');
    const id = corpusId(100);
    const restricted = clone(input);
    restricted.snapshot.context.asset_links[0].intended_visibility =
      'restricted';
    restricted.source_sha256 = dossierSourceHash(restricted.snapshot);
    expectRejection(restricted, 'PRIVATE_ASSET');
    const evidence = clone(input);
    evidence.snapshot.assets[0].access_class = 'rights_evidence';
    evidence.source_sha256 = dossierSourceHash(evidence.snapshot);
    expectRejection(evidence, 'RIGHTS_EVIDENCE_ASSET');
    expectRejection(
      { ...input, source_sha256: 'a'.repeat(64) },
      'SOURCE_HASH_MISMATCH'
    );
    expectRejection(
      { ...input, bindings: { ...input.bindings, media: {} } },
      'MISSING_MEDIA_BINDING'
    );
    expectRejection(
      {
        ...input,
        bindings: {
          ...input.bindings,
          media: { [id]: 'http://media.example/plain' }
        }
      },
      'INVALID_MEDIA_URL'
    );
    expectRejection(
      { ...input, roles: { [id]: 'museum_copy' as never } },
      'UNSUPPORTED_ROLE'
    );
    expectRejection({ ...input, roles: {} }, 'MISSING_ROLE');
    expectRejection(
      { ...input, roles: { [id]: 'live_upstream_service' } },
      'INCONSISTENT_ROLE'
    );
    expectRejection(
      {
        ...input,
        rights: { ...input.rights, rights_uri: 'https://example.org/license' }
      },
      'RIGHTS_URI_NOT_IN_REGISTRY'
    );
    expectRejection(
      {
        ...input,
        rights: {
          rights_uri: PUBLICATION_RIGHTS_URI,
          required_statement: { label: 'Credit', value: '  ' }
        }
      },
      'ATTRIBUTION_REQUIRED'
    );
    expectRejection(
      {
        ...input,
        rights: {
          ...input.rights,
          provider: { id: 'ftp://museum', label: 'x' }
        }
      },
      'INVALID_PROVIDER'
    );
    expectRejection(
      { ...input, selection: { asset_ids: [corpusId(999)] } },
      'UNKNOWN_ASSET'
    );
    expectRejection(
      { ...input, selection: { asset_ids: [] } },
      'EMPTY_SELECTION'
    );
    expectRejection(
      { ...input, selection: { asset_ids: [id, id] } },
      'DUPLICATE_SELECTION'
    );
    expectRejection(
      { ...input, compiler_version: 'other' },
      'UNSUPPORTED_COMPILER_VERSION'
    );
    fc.assert(
      fc.property(
        fc.constantFrom(
          'http://6529.io/iiif/objects/x',
          'https://6529.io/iiif/objects/x?draft=1',
          'https://6529.io/iiif/objects/x#manifest',
          'https://user:pw@6529.io/iiif/objects/x',
          'https://6529.io',
          'https://6529.io/iiif/objects/<x>',
          'https://6529.io/iiif/objects/.hidden',
          'ipfs://bafy',
          'not a url',
          ''
        ),
        (base_url) =>
          expectRejection(
            { ...input, bindings: { ...input.bindings, base_url } },
            'INVALID_BASE_URL'
          )
      )
    );
  });

  it('rejects a selection with no measurable canvas', () => {
    const { input } = publicationFixture('still-image');
    const flat = clone(input);
    flat.snapshot.assets[0].width = null;
    flat.snapshot.assets[0].height = null;
    flat.source_sha256 = dossierSourceHash(flat.snapshot);
    expectRejection(flat, 'NO_PRESENTABLE_CANVAS');
  });
});
