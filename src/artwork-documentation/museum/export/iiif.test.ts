import { buildIiif } from './iiif';
import { dossierFixture } from './dossier-fixture';
import { Answer, Json } from '../../artwork-documentation.types';

const answer = (value: unknown): Answer => ({
  status: 'provided',
  intended_visibility: 'public_record',
  value: value as Json
});
const base = 'https://example.invalid/test';
function movieFixture() {
  const { snapshot } = dossierFixture();
  const asset = snapshot.assets[0];
  asset.detected_mime = 'video/mp4';
  asset.extension = 'mp4';
  asset.technical_metadata_json = JSON.stringify({
    properties: { duration_seconds: 100 }
  });
  return { snapshot, asset };
}

describe('IIIF Presentation 3 source mapping', () => {
  it('uses measured dimensions for offset paintings in both canvas bounds and target fragments', () => {
    const { snapshot } = dossierFixture();
    const asset = snapshot.assets[0];
    asset.width = 100;
    asset.height = 80;
    snapshot.context.modules.preservation.presentation_scenes = answer([
      {
        id: 'offset',
        title: 'Offset image',
        resources: [{ asset_id: asset.id, role: 'painting', x: 10, y: 5 }]
      }
    ]);
    const result = buildIiif(snapshot.context, snapshot.assets, base);
    expect(result.manifest.items[0]).toMatchObject({ width: 110, height: 85 });
    expect(JSON.stringify(result.manifest)).toContain(
      `${base}/canvas/offset#xywh=10,5,100,80`
    );
    expect(result.issues).toEqual([]);
    snapshot.context.modules.preservation.presentation_scenes = answer([
      {
        id: 'offset',
        title: 'Offset image',
        width: 105,
        height: 85,
        resources: [{ asset_id: asset.id, role: 'painting', x: 10, y: 5 }]
      }
    ]);
    const outside = buildIiif(snapshot.context, snapshot.assets, base);
    expect(outside.issues).toHaveLength(1);
    expect(JSON.stringify(outside.manifest.items)).not.toContain(
      `${base}/originals/${asset.id}`
    );
  });
  it.each([
    {},
    { properties: null },
    { properties: { duration_seconds: 'unknown' } }
  ])(
    'retains a time-based original without inventing a canvas for incomplete metadata %p',
    (metadata) => {
      const { snapshot, asset } = movieFixture();
      asset.technical_metadata_json = JSON.stringify(metadata);
      const result = buildIiif(snapshot.context, snapshot.assets, base);
      expect(result.manifest.items).toEqual([]);
      expect(result.manifest.rendering).toContainEqual(
        expect.objectContaining({ id: `${base}/originals/${asset.id}` })
      );
      expect(result.issues).toHaveLength(1);
      expect(JSON.stringify(result.manifest)).not.toContain('"duration"');
    }
  );
  it('preserves selected file order and retains nonpaintable originals as renderings', () => {
    const { snapshot } = dossierFixture();
    const first = snapshot.assets[0];
    const second = { ...first, id: 'second', filename: 'Second.png' };
    const code = {
      ...first,
      id: 'code',
      filename: 'index.html',
      detected_mime: 'text/html',
      extension: 'html'
    };
    snapshot.context.asset_links.unshift({
      ...snapshot.context.asset_links[0],
      id: 'second-link',
      asset_id: second.id
    });
    const result = buildIiif(snapshot.context, [first, second, code], base);
    expect(result.manifest.items.map((item) => item.id)).toEqual([
      `${base}/canvas/second-link`,
      `${base}/canvas/${snapshot.context.asset_links[1].id}`
    ]);
    expect(result.bindings[`${base}/originals/code`]).toBe(
      'data/originals/code.html'
    );
    expect(result.manifest.rendering).toContainEqual(
      expect.objectContaining({ id: `${base}/originals/code`, type: 'Text' })
    );
    expect(JSON.stringify(result.manifest.items)).not.toContain(
      '/originals/code'
    );
  });
  it('maps explicit spatial layout, source clips, timing and multilingual captions without treating text as HTML', () => {
    const { snapshot, asset } = movieFixture();
    snapshot.context.modules.preservation.presentation_scenes = answer([
      {
        id: 'scene',
        title: 'Projection',
        width: 100,
        height: 100,
        duration_seconds: 40,
        resources: [
          {
            asset_id: asset.id,
            role: 'painting',
            x: 5,
            y: 10,
            width: 50,
            height: 80,
            start_seconds: 10,
            end_seconds: 30,
            source_start_seconds: 20,
            source_end_seconds: 60,
            time_mode: 'scale'
          }
        ],
        annotations: [
          {
            id: 'caption',
            kind: 'caption',
            language: 'el',
            text: '<script>literal writing</script>',
            start_seconds: 10,
            end_seconds: 12
          }
        ]
      }
    ]);
    const result = buildIiif(snapshot.context, snapshot.assets, base);
    const serialized = JSON.stringify(result.manifest);
    expect(serialized).toContain(
      `${base}/canvas/scene#xywh=5,10,50,80&t=10,30`
    );
    expect(serialized).toContain(`${base}/originals/${asset.id}#t=20,60`);
    expect(serialized).toContain('"timeMode":"scale"');
    expect(serialized).toContain('"format":"text/plain","language":"el"');
    expect(result.issues).toEqual([]);
  });
  it('maps one recording transcript into a scaled clip and preserves unaligned text separately', () => {
    const { snapshot, asset } = movieFixture();
    snapshot.context.modules.preservation.presentation_scenes = answer([
      {
        id: 'scene',
        title: 'Interview excerpt',
        duration_seconds: 20,
        resources: [
          {
            asset_id: asset.id,
            role: 'painting',
            source_start_seconds: 20,
            source_end_seconds: 60,
            end_seconds: 20,
            time_mode: 'scale'
          }
        ]
      }
    ]);
    snapshot.context.modules.interview.sessions = answer([
      {
        id: 'session',
        title: 'Interview',
        language: 'en',
        recording_asset_ids: [asset.id],
        transcript_text: 'A complete transcript.\n\nAnother paragraph.',
        segments: [
          {
            speaker_agent_id: 'artist',
            start_seconds: 30,
            end_seconds: 40,
            text: 'Inside clip'
          },
          {
            speaker_agent_id: 'artist',
            start_seconds: 70,
            end_seconds: 80,
            text: 'Outside clip'
          }
        ]
      }
    ]);
    const result = buildIiif(snapshot.context, snapshot.assets, base);
    const serialized = JSON.stringify(result.manifest);
    expect(serialized).toContain(`${base}/canvas/scene#t=5,10`);
    expect(serialized).toContain('Outside clip');
    expect(serialized).toContain(
      'A complete transcript.\\n\\nAnother paragraph.'
    );
    expect(result.issues).toHaveLength(1);
  });
  it('does not invent canvas extent or timing for unsupported files and ambiguous recordings', () => {
    const { snapshot, asset } = movieFixture();
    snapshot.context.modules.interview.sessions = answer([
      {
        id: 'session',
        language: 'en',
        recording_asset_ids: [asset.id, 'second'],
        segments: [
          {
            speaker_agent_id: 'artist',
            start_seconds: 10,
            end_seconds: 20,
            text: 'Which recording?'
          }
        ]
      }
    ]);
    const result = buildIiif(snapshot.context, snapshot.assets, base);
    expect(JSON.stringify(result.manifest)).not.toContain('#t=10,20');
    expect(result.issues).toHaveLength(1);
    asset.technical_metadata_json = null;
    expect(
      buildIiif(snapshot.context, snapshot.assets, base).manifest.items
    ).toEqual([]);
    expect(() =>
      buildIiif(snapshot.context, snapshot.assets, 'javascript:alert(1)')
    ).toThrow();
  });
  it('retains out-of-bounds captions without assigning false positions and rejects image source clips', () => {
    const { snapshot } = dossierFixture();
    snapshot.context.modules.preservation.presentation_scenes = answer([
      {
        id: 'scene',
        title: 'Image',
        resources: [
          {
            asset_id: snapshot.assets[0].id,
            role: 'painting',
            source_start_seconds: 1,
            source_end_seconds: 2
          }
        ],
        annotations: [
          {
            id: 'caption',
            kind: 'caption',
            language: 'en',
            text: 'Retain this caption',
            start_seconds: 10,
            end_seconds: 20
          }
        ]
      }
    ]);
    const result = buildIiif(snapshot.context, snapshot.assets, base);
    const serialized = JSON.stringify(result.manifest);
    expect(serialized).toContain('Retain this caption');
    expect(serialized).not.toContain('#t=');
    expect(result.issues).toHaveLength(2);
  });
});
