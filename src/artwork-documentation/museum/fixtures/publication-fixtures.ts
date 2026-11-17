import { dossierSourceHash } from '../export/dossier';
import {
  PUBLICATION_COMPILER_VERSION,
  PublicationInput,
  ResourceRole
} from '../publication/publication.types';
import { attach, Corpus, corpusId, mediaCorpus, write } from './museum-corpus';

/**
 * Publication inputs built on the museum capture corpus. Media URLs point at
 * a documented placeholder host; the manifests are structural fixtures, not
 * served publications. Measured facts the upload pipeline would supply
 * (dimensions, duration, capture date) are declared here explicitly.
 */
export const PUBLICATION_CASES = [
  'still-image',
  'timed-media',
  'multipart',
  'generative-surrogate'
] as const;
export type PublicationCase = (typeof PUBLICATION_CASES)[number];

export const PUBLICATION_MEDIA_HOST = 'https://media.example';
export const PUBLICATION_RIGHTS_URI =
  'https://creativecommons.org/publicdomain/zero/1.0/';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWuoAAAAASUVORK5CYII=',
  'base64'
);

function measure(
  corpus: Corpus,
  assetId: string,
  facts: {
    width?: number;
    height?: number;
    duration_seconds?: number;
    capture_date?: string;
  }
) {
  const asset = corpus.snapshot.assets.find((item) => item.id === assetId)!;
  if (facts.width !== undefined) asset.width = facts.width;
  if (facts.height !== undefined) asset.height = facts.height;
  const properties: Record<string, string | number> = {};
  if (facts.duration_seconds !== undefined)
    properties.duration_seconds = facts.duration_seconds;
  if (facts.capture_date !== undefined)
    properties.capture_date = facts.capture_date;
  if (Object.keys(properties).length)
    asset.technical_metadata_json = JSON.stringify({ properties });
}

function finish(
  name: PublicationCase,
  corpus: Corpus,
  roles: Record<string, ResourceRole>
): { input: PublicationInput; corpus: Corpus } {
  const snapshot = corpus.snapshot;
  const media: Record<string, string> = {};
  for (const id of Object.keys(roles)) {
    const asset = snapshot.assets.find((item) => item.id === id)!;
    media[id] =
      `${PUBLICATION_MEDIA_HOST}/publication/${name}/${id}.${asset.extension}`;
  }
  return {
    corpus,
    input: {
      snapshot,
      source_sha256: dossierSourceHash(snapshot),
      selection: { asset_ids: Object.keys(roles) },
      bindings: {
        base_url: `https://6529.io/iiif/objects/stream-${name}`,
        media
      },
      rights: {
        rights_uri: PUBLICATION_RIGHTS_URI,
        required_statement: {
          label: 'Credit',
          value: 'Synthetic Test Artist, Test Work, 2026. CC0 1.0.'
        },
        provider: { id: 'https://6529.io/museum', label: '6529 Museum' }
      },
      roles,
      compiler_version: PUBLICATION_COMPILER_VERSION
    }
  };
}

export function publicationFixture(name: PublicationCase) {
  if (name === 'still-image') {
    const corpus = mediaCorpus(['digital_art']);
    measure(corpus, corpusId(100), { width: 10, height: 10 });
    return finish(name, corpus, {
      [corpusId(100)]: 'authorized_manifestation'
    });
  }
  if (name === 'timed-media') {
    const corpus = mediaCorpus(['video']);
    measure(corpus, corpusId(100), {
      width: 64,
      height: 64,
      duration_seconds: 1
    });
    return finish(name, corpus, {
      [corpusId(100)]: 'authorized_manifestation'
    });
  }
  if (name === 'multipart') {
    const corpus = mediaCorpus([
      'installation',
      'photography',
      'audio',
      'spatial'
    ]);
    const [archive, photo, audio, model] = [100, 101, 102, 103].map(corpusId);
    measure(corpus, audio, { duration_seconds: 1 });
    write(corpus.snapshot.context, 'preservation', 'presentation_scenes', [
      {
        id: corpusId(700),
        title: 'Installation view',
        resources: [{ asset_id: photo, role: 'painting' }],
        annotations: [
          {
            id: corpusId(701),
            kind: 'description',
            language: 'en',
            text: 'Documentation photograph of the installed components.'
          }
        ]
      },
      {
        id: corpusId(702),
        title: 'Sound component',
        resources: [{ asset_id: audio, role: 'painting' }]
      }
    ]);
    return finish(name, corpus, {
      [archive]: 'preservation_master',
      [photo]: 'documentation_surrogate',
      [audio]: 'authorized_manifestation',
      [model]: 'technical_model'
    });
  }
  const corpus = mediaCorpus(['generative']);
  const still = corpusId(110);
  attach(
    corpus,
    still,
    'reference-capture.png',
    'image/png',
    ONE_PIXEL_PNG,
    'reference_capture'
  );
  measure(corpus, still, { capture_date: '2026-09-12' });
  write(corpus.snapshot.context, 'context', 'sources', [
    {
      id: corpusId(120),
      kind: 'artwork',
      title: 'Live generator (upstream, mutable)',
      url: 'https://generator.example/works/synthetic-seed-1'
    }
  ]);
  return finish(name, corpus, {
    [corpusId(100)]: 'preservation_master',
    [still]: 'documentation_surrogate'
  });
}
