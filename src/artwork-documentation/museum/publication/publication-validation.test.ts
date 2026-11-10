import { publicationFixture } from '../fixtures/publication-fixtures';
import { compilePublication } from './publication-compiler';
import { validatePublicationManifest } from './publication-validation';

function compiled() {
  const { input } = publicationFixture('multipart');
  const result = compilePublication(input);
  const manifest = JSON.parse(JSON.stringify(result.manifest)) as Record<
    string,
    any
  >;
  const expectations = {
    base_url: input.bindings.base_url,
    media_urls: Object.values(input.bindings.media)
  };
  return { manifest, expectations };
}
const codes = (
  manifest: unknown,
  expectations: { base_url: string; media_urls: string[] }
) =>
  validatePublicationManifest(manifest, expectations).errors.map(
    (error) => error.code
  );

describe('Publication manifest structural validation', () => {
  it('accepts the compiled fixture', () => {
    const { manifest, expectations } = compiled();
    expect(validatePublicationManifest(manifest, expectations)).toEqual({
      ok: true,
      errors: []
    });
  });
  it('requires the IIIF context first, the bound manifest id and a registry rights URI', () => {
    const { manifest, expectations } = compiled();
    const reordered = { id: manifest.id, ...manifest };
    expect(codes(reordered, expectations)).toContain('CONTEXT_FIRST');
    expect(
      codes({ ...manifest, id: 'https://other.example/manifest' }, expectations)
    ).toContain('MANIFEST_ID_INVALID');
    expect(
      codes(
        {
          ...manifest,
          rights: 'https://creativecommons.org/publicdomain/zero/1.0/'
        },
        expectations
      )
    ).toContain('RIGHTS_NOT_IN_REGISTRY');
    expect(
      codes({ ...manifest, rights: 'http://example.org/license' }, expectations)
    ).toContain('RIGHTS_NOT_IN_REGISTRY');
  });
  it('requires attribution, the source link, metadata and at least one canvas', () => {
    const { manifest, expectations } = compiled();
    const { requiredStatement: _statement, ...noStatement } = manifest;
    expect(codes(noStatement, expectations)).toContain('KEY_VALUE_INVALID');
    expect(
      codes(
        {
          ...manifest,
          seeAlso: [{ id: 'https://x.example/a', type: 'Dataset' }]
        },
        expectations
      )
    ).toContain('SOURCE_LINK_REQUIRED');
    expect(codes({ ...manifest, items: [] }, expectations)).toContain(
      'CANVAS_REQUIRED'
    );
    expect(codes({ ...manifest, metadata: [] }, expectations)).toContain(
      'METADATA_REQUIRED'
    );
    expect(codes({ ...manifest, extra: true }, expectations)).toContain(
      'UNEXPECTED_MEMBER'
    );
  });
  it('checks canvases, painting annotations and media bindings', () => {
    const { manifest, expectations } = compiled();
    const canvas = manifest.items[0];
    expect(
      codes(
        {
          ...manifest,
          items: [{ ...canvas, width: undefined, height: undefined }]
        },
        expectations
      )
    ).toContain('CANVAS_EXTENT_REQUIRED');
    expect(
      codes(
        { ...manifest, items: [{ ...canvas, height: undefined }] },
        expectations
      )
    ).toContain('CANVAS_EXTENT_INVALID');
    const page = canvas.items[0];
    const annotation = page.items[0];
    const painted = (patch: Record<string, unknown>) => ({
      ...manifest,
      items: [
        {
          ...canvas,
          items: [{ ...page, items: [{ ...annotation, ...patch }] }]
        }
      ]
    });
    expect(
      codes(painted({ motivation: 'commenting' }), expectations)
    ).toContain('PAINTING_REQUIRED');
    expect(
      codes(
        painted({ target: 'https://6529.io/iiif/objects/elsewhere/canvas/1' }),
        expectations
      )
    ).toContain('TARGET_INVALID');
    expect(
      codes(
        painted({
          body: { ...annotation.body, id: 'https://media.example/unbound.png' }
        }),
        expectations
      )
    ).toContain('MEDIA_NOT_BOUND');
    expect(
      codes(
        painted({ body: { ...annotation.body, format: 'png' } }),
        expectations
      )
    ).toContain('BODY_FORMAT_INVALID');
    expect(codes(manifest, { ...expectations, media_urls: [] })).toContain(
      'MEDIA_NOT_BOUND'
    );
    expect(
      codes(
        {
          ...manifest,
          items: [{ ...canvas, id: 'https://other.example/canvas/1' }]
        },
        expectations
      )
    ).toContain('CANVAS_ID_INVALID');
    expect(
      codes(
        {
          ...manifest,
          items: [{ ...canvas, label: { 'bad language!': ['x'] } }]
        },
        expectations
      )
    ).toContain('LANGUAGE_MAP_INVALID');
  });
  it('rejects non-object input', () => {
    expect(
      validatePublicationManifest('manifest', {
        base_url: 'https://x.example/a',
        media_urls: []
      }).ok
    ).toBe(false);
  });
});
