import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyOperations,
  emptyModules,
  getProfile
} from '../../artwork-documentation.catalogue';
import {
  Answer,
  ContextRecord,
  Json,
  ModuleId
} from '../../artwork-documentation.types';
import { StoredAsset } from '../../assets/artwork-assets.types';
import { DossierSnapshot } from '../export/dossier.types';
import { MEDIA_PROFILE_IDS, MediaProfileId } from '../museum-record.types';
import { bindMuseumProgram } from '../museum-catalogue';
import {
  INSTALLATION_COMPONENT_ID,
  MEDIA_CAPTURE_ACCOUNTS
} from './media-accounts';

export const corpusId = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const provided = (value: Json): Answer => ({
  status: 'provided',
  value,
  intended_visibility: 'public_record'
});
export function write(
  context: ContextRecord,
  module: ModuleId,
  field: string,
  value: Json
) {
  context.modules[module] = applyOperations(
    module,
    context.modules[module],
    [{ op: 'set', field, answer: provided(value) }],
    context.profile
  );
}
const localized = (text: string) => ({
  primary_language: 'en',
  versions: [
    { language: 'en', text, authorship: 'original', approved_by_artist: true }
  ]
});
export type Corpus = {
  snapshot: DossierSnapshot;
  originals: Map<string, Buffer>;
};

function blank(): Corpus {
  const context: ContextRecord = {
    id: corpusId(1),
    work_id: corpusId(2),
    owner_profile_id: 'synthetic-corpus-owner',
    program_id: null,
    profile: getProfile('stream_artwork_basic_v1', 3),
    draft_version: 1,
    artist_record_revision_id: null,
    latest_revision_id: null,
    lifecycle: 'active',
    modules: emptyModules(),
    asset_links: [],
    restricted_paths: [],
    created_at: Date.UTC(2026, 8, 12),
    updated_at: Date.UTC(2026, 8, 12)
  };
  return {
    snapshot: JSON.parse(
      JSON.stringify({
        context,
        assets: [],
        museum_records: [],
        source_receipts: [],
        confirmed_revision: null,
        confirmation: 'unconfirmed'
      })
    ),
    originals: new Map()
  };
}
function attach(
  corpus: Corpus,
  id: string,
  filename: string,
  mime: string,
  bytes: Buffer,
  role: StoredAsset['role'] = 'artwork_final'
) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const asset = {
    id,
    context_id: corpus.snapshot.context.id,
    uploader_profile_id: 'test-fixture',
    filename,
    extension: filename.split('.').pop()!,
    role,
    access_class: 'artwork',
    intended_visibility: 'public_record',
    state: 'ready',
    size_bytes: bytes.length,
    sha256: hash,
    detected_mime: mime,
    declared_mime: mime,
    scan_status: null,
    inspection_status: 'unsupported',
    width: mime === 'image/png' ? bytes.readUInt32BE(16) : null,
    height: mime === 'image/png' ? bytes.readUInt32BE(20) : null,
    created_at: Date.UTC(2026, 8, 12),
    updated_at: Date.UTC(2026, 8, 12)
  } as StoredAsset;
  corpus.snapshot.assets.push(asset);
  corpus.snapshot.context.asset_links.push({
    id: corpusId(500 + corpus.snapshot.assets.length),
    asset_id: id,
    role,
    label: filename,
    description:
      'Local test fixture bytes. This fixture is not a production upload or a safety-scan receipt.',
    intended_visibility: 'public_record',
    source_of_asset: 'test fixture',
    source_credit: '',
    derived_from_asset_ids: [],
    deposit_note: 'No live scanner or provenance verification is asserted.',
    intended_terms: { kind: 'unspecified' },
    manifest: {
      id,
      filename,
      detected_mime: mime,
      size_bytes: bytes.length,
      sha256: hash,
      width: asset.width,
      height: asset.height
    }
  });
  corpus.originals.set(id, bytes);
}
function artifact(media: MediaProfileId): {
  filename: string;
  mime: string;
  bytes: Buffer;
} {
  if (media === 'photography')
    return {
      filename: 'synthetic-pixel.png',
      mime: 'image/png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWuoAAAAASUVORK5CYII=',
        'base64'
      )
    };
  if (media === 'digital_art')
    return {
      filename: 'synthetic.svg',
      mime: 'image/svg+xml',
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>'
      )
    };
  if (media === 'video')
    return {
      filename: 'synthetic-blue.mp4',
      mime: 'video/mp4',
      bytes: readFileSync(join(__dirname, 'synthetic-blue.mp4'))
    };
  if (media === 'audio') {
    const wav = Buffer.alloc(8044, 128);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(8036, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(8000, 28);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt16LE(8, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(8000, 40);
    return { filename: 'synthetic-silence.wav', mime: 'audio/wav', bytes: wav };
  }
  if (media === 'spatial')
    return {
      filename: 'synthetic-scene.gltf',
      mime: 'model/gltf+json',
      bytes: Buffer.from(
        JSON.stringify({
          asset: { version: '2.0' },
          scene: 0,
          scenes: [{ nodes: [] }]
        })
      )
    };
  if (media === 'text')
    return {
      filename: 'synthetic-poem.txt',
      mime: 'text/plain',
      bytes: Buffer.from(
        String(
          (MEDIA_CAPTURE_ACCOUNTS.text as Record<string, Json>)
            .authoritative_text
        )
      )
    };
  if (media === 'installation')
    return {
      filename: 'synthetic-installation.zip',
      mime: 'application/zip',
      bytes: readFileSync(join(__dirname, 'synthetic-installation.zip'))
    };
  return {
    filename: 'index.html',
    mime: 'text/html',
    bytes: Buffer.from(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic test work</title><main>Test fixture</main></html>'
    )
  };
}

/** All baseline and selected-media answers pass the actual server field schemas. */
export function mediaCorpus(media: MediaProfileId[]): Corpus {
  const corpus = blank();
  const context = corpus.snapshot.context;
  for (const [module, field, value] of [
    ['identity', 'display_name', 'Synthetic Test Artist'],
    ['identity', 'preferred_credit', 'Synthetic Test Artist, Test Work, 2026'],
    ['identity', 'record_language', 'en'],
    ['artwork', 'title', 'Synthetic media capture vector'],
    ['artwork', 'title_language', 'en'],
    ['artwork', 'media_profiles', media],
    [
      'context',
      'caption',
      localized(
        'A synthetic artwork record for checking capture and archival interchange.'
      )
    ],
    ['files', 'master_availability', { kind: 'same_as_final' }],
    ['rights', 'rights_basis', { kind: 'artist_owned' }],
    ['rights', 'third_party_material', { kind: 'none' }],
    [
      'rights',
      'intended_license',
      {
        uri: 'https://creativecommons.org/publicdomain/zero/1.0/',
        label: 'CC0'
      }
    ],
    [
      'rights',
      'rights_declaration',
      'A synthetic rights account, not a real grant.'
    ],
    ['rights', 'declaration_effect', 'unknown'],
    [
      'preservation',
      'intent',
      {
        account:
          'Retain the artistic relationships described in the media account.',
        significant_properties: [
          {
            id: corpusId(20),
            property: 'Composition and timing',
            reason: 'They determine the encounter.',
            acceptable_variation: 'Only the variations expressly described.'
          }
        ],
        change_policy: 'Review any change against the recorded intent.'
      }
    ]
  ] as [ModuleId, string, Json][])
    write(context, module, field, value);
  media.forEach((profile, index) => {
    const file = artifact(profile);
    attach(corpus, corpusId(100 + index), file.filename, file.mime, file.bytes);
    const account = JSON.parse(
      JSON.stringify(MEDIA_CAPTURE_ACCOUNTS[profile])
    ) as Record<string, Json>;
    if (profile === 'video' || profile === 'audio')
      account.duration = { kind: 'fixed', seconds: 1 };
    write(context, 'process', profile, account);
  });
  write(context, 'artwork', 'canonical_asset_id', corpusId(100));
  if (media.includes('installation'))
    write(context, 'artwork', 'components', [
      {
        id: INSTALLATION_COMPONENT_ID,
        kind: 'component',
        name: 'Synthetic installation component',
        description: 'A described component in the test installation.',
        asset_ids: [corpusId(100)]
      }
    ]);
  return corpus;
}

export const CAPTURE_CASES: readonly MediaProfileId[][] = [
  ...MEDIA_PROFILE_IDS.map((id) => [id]),
  ['photography', 'html', 'interactive'],
  ['installation', 'photography', 'audio', 'spatial']
];

export const AN_ALTERATION_SOURCE_SHA256 =
  '51348533f11d1b27381f07971ea9a9aeff024ede39b02ad6b8509ebb3810447e';
export const AN_ALTERATION_PREVIEW_SHA256 =
  '4fe97f0b02115df2a1b084599c774652b7a23990a0735bf5a2e5ac6dcc917b79';
export function alterationCorpus(): Corpus & {
  source: string;
  sections: string[];
} {
  const corpus = blank();
  const context = corpus.snapshot.context;
  context.owner_profile_id = 'user-supplied-example-record';
  context.program_id = '6529NM-AP-01';
  context.profile = JSON.parse(
    JSON.stringify(bindMuseumProgram(context.profile, context.program_id))
  );
  const bytes = readFileSync(join(__dirname, 'an-alteration.txt'));
  const source = bytes.toString('utf8');
  const sections = source.split(/_{20,}\r?\n/).slice(1);
  const excerpt = (section: number, from: string, to: string) => {
    const part = sections[section - 1];
    const start = part.indexOf(from) + from.length;
    return part
      .slice(start, part.indexOf(to, start))
      .replace(/^\r?\n/, '')
      .replace(/\r?\n$/, '');
  };
  write(context, 'identity', 'display_name', 'Elia Maris');
  write(
    context,
    'identity',
    'preferred_credit',
    'Elia Maris, AN ALTERATION, 2026'
  );
  write(context, 'identity', 'record_language', 'en');
  write(context, 'identity', 'agents', [
    {
      id: corpusId(3),
      kind: 'person',
      name: 'Elia Maris',
      biography: excerpt(4, 'About the artist', 'Artist links')
    },
    { id: corpusId(4), kind: 'person', name: 'Leonie Karras' }
  ]);
  write(context, 'artwork', 'title', 'AN ALTERATION');
  write(context, 'artwork', 'title_language', 'en');
  write(context, 'artwork', 'media_profiles', ['photography']);
  write(
    context,
    'context',
    'caption',
    localized(excerpt(2, 'Caption', 'Artist statement'))
  );
  write(
    context,
    'context',
    'artist_statement',
    localized(excerpt(2, 'Artist statement', 'Circumstances of making'))
  );
  write(
    context,
    'context',
    'making_context',
    excerpt(2, 'Circumstances of making', 'Connection to Keys and Gates')
  );
  write(context, 'context', 'theme_connection', {
    kind: 'text',
    text: excerpt(
      2,
      'Connection to Keys and Gates',
      'What viewers might misunderstand'
    )
  });
  write(context, 'process', 'photography', {
    capture_process: excerpt(3, 'Exposure notes', 'Techniques'),
    editing: excerpt(3, 'How the work was made', 'Material changes'),
    crop_and_color_intent: excerpt(
      6,
      'Orientation, frame and cropping',
      'Screen display'
    )
  });
  write(
    context,
    'preservation',
    'print_preferences',
    excerpt(
      6,
      'Printing preferences and production instructions',
      'Acceptable future changes'
    )
  );
  write(context, 'preservation', 'intent', {
    account: excerpt(
      6,
      'What needs to survive',
      'Orientation, frame and cropping'
    ),
    significant_properties: [],
    change_policy: excerpt(
      6,
      'Acceptable future changes',
      'Related physical materials'
    )
  });
  write(context, 'rights', 'rights_basis', {
    kind: 'artist_owned',
    detail: excerpt(5, 'Authorship and rights basis', 'Artwork license')
  });
  write(context, 'rights', 'third_party_material', { kind: 'none' });
  write(context, 'context', 'documents', [
    {
      id: corpusId(30),
      kind: 'reference',
      title: 'Exact user-supplied best-practice source',
      language: 'en',
      text: source,
      authors: [],
      authorship: 'original',
      review_status: 'draft'
    },
    ...sections.map((text, index) => ({
      id: corpusId(31 + index),
      kind: 'reference',
      title: text.split(/\r?\n/)[0],
      language: 'en',
      text,
      authors: [
        { agent_id: corpusId(3), role: 'artist account in supplied example' }
      ],
      authorship: 'original',
      review_status: 'draft'
    }))
  ]);
  const transcript = excerpt(
    7,
    'Interview with Elia Maris by Leonie Karras',
    'Interview supporting fields'
  );
  const questions = transcript
    .split(/\r?\n/)
    .filter((line) => /^(Leonie Karras|Karras): /.test(line))
    .map((line, index) => ({
      id: `q${index + 1}`,
      text: line.replace(/^(Leonie Karras|Karras): /, '')
    }));
  write(context, 'interview', 'sessions', [
    {
      id: corpusId(40),
      title: 'Interview with Elia Maris by Leonie Karras',
      date: { start: '2026-06-02', precision: 'day', approximate: false },
      language: 'en',
      mode: 'written',
      participants: [
        { agent_id: corpusId(3), role: 'artist' },
        { agent_id: corpusId(4), role: 'interviewer' }
      ],
      instrument: {
        id: 'an-alteration-written-conversation',
        version: '1',
        title: 'Complete supplied conversation',
        questions
      },
      transcript_text: transcript,
      publication_permission: 'intended_public_record'
    }
  ]);
  const named = [
    'EM_AN-ALTERATION_2026_MASTER.tif',
    'Original Phase One IIQ capture',
    'Capture One session',
    'Layered Photoshop working file',
    'EM_AN-ALTERATION_2026_PRINT_120x80_PRB315.tif',
    'Custom ICC profile',
    'Saved output settings and media preset',
    'Selected 2023 site photograph',
    'Field-note scans',
    'Proofing notes',
    'EM_AN-ALTERATION_INTERVIEW_2026.txt'
  ];
  write(
    context,
    'files',
    'described_materials',
    named.map((name, index) => ({
      id: corpusId(60 + index),
      name,
      kind: 'material named in supplied sample',
      description:
        'The source describes this material; its bytes were not received with the sample.',
      availability: 'expected'
    }))
  );
  const custody =
    excerpt(1, 'Existing edition statement', 'Visual description') +
    '\n\n' +
    excerpt(6, 'Related physical materials', 'These accompany the photograph');
  write(
    context,
    'artwork',
    'physical_objects',
    [80, 81].map((n) => ({
      id: corpusId(n),
      kind: 'print',
      name: `Reference print ${n - 79}`,
      materials: 'Pigment ink on Hahnemühle Photo Rag Baryta, 315 gsm.',
      status: 'described',
      custody_note: custody,
      note: 'The sample contains conflicting statements about the location of the reference prints. No physical delivery is established.'
    }))
  );
  write(context, 'artwork', 'measurements', [
    {
      id: corpusId(90),
      subject_id: corpusId(60),
      kind: 'width',
      scope: 'digital_file',
      value: 14202,
      unit: 'px',
      note: 'Dimensions declared for the named TIFF, not measured from the supplied PNG.'
    },
    {
      id: corpusId(91),
      subject_id: corpusId(60),
      kind: 'height',
      scope: 'digital_file',
      value: 9468,
      unit: 'px',
      note: 'Dimensions declared for the named TIFF, not measured from the supplied PNG.'
    },
    ...[80, 81].flatMap((n) => [
      {
        id: corpusId(200 + n),
        subject_id: corpusId(n),
        kind: 'width',
        scope: 'image',
        value: 120,
        unit: 'cm'
      },
      {
        id: corpusId(300 + n),
        subject_id: corpusId(n),
        kind: 'height',
        scope: 'image',
        value: 80,
        unit: 'cm'
      },
      {
        id: corpusId(400 + n),
        subject_id: corpusId(n),
        kind: 'width',
        scope: 'sheet',
        value: 140,
        unit: 'cm'
      },
      {
        id: corpusId(500 + n),
        subject_id: corpusId(n),
        kind: 'height',
        scope: 'sheet',
        value: 100,
        unit: 'cm'
      }
    ])
  ]);
  attach(
    corpus,
    corpusId(101),
    'AN_ALTERATION-user-original.txt',
    'text/plain',
    bytes,
    'other_supporting'
  );
  attach(
    corpus,
    corpusId(102),
    'AN_ALTERATION-user-supplied-preview.png',
    'image/png',
    readFileSync(join(__dirname, 'an-alteration-preview.png')),
    'display_derivative'
  );
  // No canonical final-file selection, custody receipt or artist confirmation is fabricated.
  return { ...corpus, source, sections };
}
